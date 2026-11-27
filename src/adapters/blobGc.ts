/**
 * ============================================================
 * Blob 垃圾回收 —— 标记 + 清扫
 * ============================================================
 *
 * 【三类垃圾，三套判据】
 *   1. **大载荷**（`payload/<hash>`）：判据是"还有没有命令/文档引用它"。
 *      历史条目被淘汰时 `TrackStore` 会发"丢失引用"通知，但**不能据此直接删**：
 *      同一条 blob 可能被另一条命令或文档本身引用（内容寻址会天然复用）。
 *      所以删除前一律用 `liveBlobRefs()` 重算一次。
 *
 *   2. **帧点云**（`frames/<ds>/<n>`）：判据是"这个数据集还用不用"。
 *      帧缓存的唯一用途是"刷新后不用重新选文件"，
 *      而它只有在草稿指向这个数据集时才有意义。
 *      数据集一换，旧缓存即使留着也永远不会被读到 —— 那是纯占用。
 *
 * 【为什么不在切换数据集时立刻删】
 *   用户导入 B 之后，v1 草稿可能仍然指向 A（下一次自动保存才改写）。
 *   立刻删 A 会让"刷新页面"恢复到 A 时点云全空。所以切换时不动，
 *   由 GC 在**草稿指针明确之后**（启动时、保存后、手动清理时）统一清扫。
 *
 *   3. **配额压力下的帧淘汰**（`lru-evicted`）：判据是"这一帧最久没被读过 /
 *      总共没被读几回"。前两类都清完仍然超过目标水位时才会走到这里 ——
 *      它删的是**还活着的数据集**，所以必须满足三个前提：数据集能重新解码
 *      （`SampleHandle.reloadable`，本端与对端各自声明）、当前帧邻域被保护、
 *      排序策略明确（LRU / LFU / 混合）。判据在 `domain/store/frameBudget.ts`。
 *      理由统一记作 `lru-evicted`：它表达的是"配额逼出来的淘汰"，
 *      用了哪种排序看 `GcPlan.lru.policy`，不必再造一个理由名。
 *
 * 【旧键的保守策略】
 *   P0 写下的 `ds#frame` 无法反解出数据集（`ds` 自己带 `#`）。
 *   判据退化为前缀匹配：能匹配上任何存活数据集的 `ds#` 就留。
 *   判不准就留 —— 多留几个 MB 是可恢复的，删掉用户的点云不是。
 */

import type { BlobMeta, BlobStore } from '../ports/blobStore'
import { isPayloadRef } from '../domain/store/blobRefs'
import {
  planFrameEviction,
  type EvictionPolicy,
  type FrameBlobRef,
  type FrameEvictionPlan,
} from '../domain/store/frameBudget'
import { classifyBlobKey, legacyFramePrefix, parseFrameBlobKey } from './blobKeys'

export type GcReason =
  | 'live-payload'
  | 'dead-payload'
  | 'live-dataset'
  | 'evicted-dataset'
  | 'legacy-live'
  | 'legacy-orphan'
  | 'unknown-kept'
  | 'unknown-dropped'
  | 'lru-evicted'

export interface GcVerdict {
  key: string
  bytes: number
  keep: boolean
  reason: GcReason
  datasetKey?: string
}

export interface GcPlan {
  verdicts: GcVerdict[]
  remove: GcVerdict[]
  keepBytes: number
  removeBytes: number
  byReason: Partial<Record<GcReason, { count: number; bytes: number }>>
  /** 配额压力下的帧淘汰明细（没触发时没有这个字段） */
  lru?: FrameEvictionPlan
}

/**
 * 配额压力参数。
 *
 * 【为什么要 `evictableDatasetKeys` 而不是直接淘汰所有活帧】
 *   只有"能重新解码"的数据集才敢删帧。恢复草稿时的句柄只读缓存
 *   （`createCachedCloudHandle`），删掉就永久丢 —— 那不是淘汰，是数据丢失。
 *   调用方按 `SampleHandle.reloadable` 决定谁能进这个集合。
 *
 * 【为什么这个集合可以有好几个数据集】第九批之后候选池是**全局**的：
 *   本端可重解码的 + 对端自报可重解码的。跨数据集统一排序才不会出现
 *   "本端只有 30MB 可腾、库里另压着 2GB 却一动不能动"。
 */
export interface FrameBudget {
  /** 需要腾出的字节数（由调用方按 used - quota×目标比例 算出） */
  reclaimBytes: number
  evictableDatasetKeys: Iterable<string>
  /** 绝不动的键（本端与对端的当前帧邻域）；命中组内任一键则整组跳过 */
  protectKeys?: Iterable<string>
  /** 排序策略（lru / lfu / hybrid）；不给则用默认混合策略 */
  policy?: EvictionPolicy
}

export interface GcInput {
  entries: BlobMeta[]
  /** 当前仍被命令或文档引用的大载荷键 */
  livePayloadRefs: Iterable<string>
  /** 仍然需要用帧缓存的数据集：正在看的 + 草稿指向的 */
  liveDatasetKeys: Iterable<string>
  /** 未知命名空间是否也清扫；默认 false（宁可留，不可误删） */
  dropUnknown?: boolean
  /** 配额压力下的帧淘汰；不传就只做前两类判定 */
  budget?: FrameBudget
}

function tally(plan: GcPlan, v: GcVerdict): void {
  const slot = plan.byReason[v.reason] ?? { count: 0, bytes: 0 }
  slot.count += 1
  slot.bytes += v.bytes
  plan.byReason[v.reason] = slot
}

/** 纯函数：给每条 blob 一个去留判定。可在 Node 里完整单测 */
export function planBlobGc(input: GcInput): GcPlan {
  const livePayload = new Set([...input.livePayloadRefs].filter(isPayloadRef))
  const datasets = [...new Set(input.liveDatasetKeys)].filter(Boolean)
  const legacyPrefixes = datasets.map(legacyFramePrefix)
  const plan: GcPlan = { verdicts: [], remove: [], keepBytes: 0, removeBytes: 0, byReason: {} }

  for (const entry of input.entries) {
    const { zone, datasetKey } = classifyBlobKey(entry.key)
    let keep: boolean
    let reason: GcReason

    switch (zone) {
      case 'payload':
        keep = livePayload.has(entry.key)
        reason = keep ? 'live-payload' : 'dead-payload'
        break
      case 'frames':
        keep = !!datasetKey && datasets.includes(datasetKey)
        reason = keep ? 'live-dataset' : 'evicted-dataset'
        break
      case 'legacy':
        keep = legacyPrefixes.some((p) => entry.key.startsWith(p))
        reason = keep ? 'legacy-live' : 'legacy-orphan'
        break
      default:
        keep = input.dropUnknown !== true
        reason = keep ? 'unknown-kept' : 'unknown-dropped'
        break
    }

    const verdict: GcVerdict = { key: entry.key, bytes: entry.bytes, keep, reason }
    if (datasetKey) verdict.datasetKey = datasetKey
    plan.verdicts.push(verdict)
    tally(plan, verdict)
    if (keep) plan.keepBytes += entry.bytes
    else {
      plan.remove.push(verdict)
      plan.removeBytes += entry.bytes
    }
  }

  if (input.budget) applyFrameBudget(plan, input.entries, input.budget)
  return plan
}

/**
 * 第二阶段：在"仍然活着"的帧里挑一部分淘汰，直到腾够字节。
 *
 * 只改判定结果，不碰存储 —— 这样 `dryRun` 与真实删除走同一段决策代码，
 * 预演里看到的条数与字节就是真跑时会删的。
 */
function applyFrameBudget(plan: GcPlan, entries: BlobMeta[], budget: FrameBudget): void {
  const keepFrames: FrameBlobRef[] = []
  for (let i = 0; i < plan.verdicts.length; i++) {
    const v = plan.verdicts[i]
    if (!v.keep) continue
    if (v.reason !== 'live-dataset' && v.reason !== 'legacy-live') continue
    const parsed = parseFrameBlobKey(v.key)
    // 旧键反解不出数据集：不参与淘汰（判不准就留），等它整段失效
    if (!parsed) continue
    keepFrames.push({
      key: v.key,
      datasetKey: parsed.datasetKey,
      frame: parsed.frame,
      bytes: v.bytes,
      lastUsedAt: entries[i]?.lastUsedAt ?? 0,
      hits: entries[i]?.hits ?? 0,
    })
  }

  const lru = planFrameEviction({
    entries: keepFrames,
    reclaimBytes: budget.reclaimBytes,
    evictableDatasetKeys: budget.evictableDatasetKeys,
    protectKeys: budget.protectKeys,
    policy: budget.policy,
  })
  plan.lru = lru
  if (!lru.keys.length) return

  const chosen = new Set(lru.keys)
  for (const v of plan.verdicts) {
    if (!v.keep || !chosen.has(v.key)) continue
    v.keep = false
    v.reason = 'lru-evicted'
    plan.keepBytes -= v.bytes
    plan.removeBytes += v.bytes
    plan.remove.push(v)
  }
  // 理由分布整体重算：前面已按旧理由统计过，逐条扣减要同时维护 keep 与 remove 两侧，
  // 漏一处就是审计数字对不上
  plan.byReason = {}
  for (const v of plan.verdicts) tally(plan, v)
}

export interface SweepOptions extends Omit<GcInput, 'entries'> {
  blobs: BlobStore
  /** 只算不删（诊断/手测用） */
  dryRun?: boolean
  /** 单次事务删除的键数上限，默认 500 */
  batchSize?: number
}

export interface SweepReport extends GcPlan {
  scanned: number
  /** 实际提交删除的键数（不存在的键也会计入，IndexedDB 删除是幂等的） */
  released: number
  errors: string[]
}

/**
 * 扫一遍库，删掉判定为垃圾的键。
 * 失败不抛错：回收是后台任务，不能因为一次事务失败把标注流程带崩。
 */
export async function sweepBlobs(opts: SweepOptions): Promise<SweepReport> {
  const errors: string[] = []
  let entries: BlobMeta[] = []
  try {
    entries = await opts.blobs.list()
  } catch (err) {
    errors.push(`枚举失败：${(err as Error).message}`)
  }

  const plan = planBlobGc({
    entries,
    livePayloadRefs: opts.livePayloadRefs,
    liveDatasetKeys: opts.liveDatasetKeys,
    dropUnknown: opts.dropUnknown,
    budget: opts.budget,
  })

  const report: SweepReport = { ...plan, scanned: entries.length, released: 0, errors }

  if (opts.dryRun || !plan.remove.length) return report

  const batchSize = Math.max(1, opts.batchSize ?? 500)
  for (let i = 0; i < plan.remove.length; i += batchSize) {
    const keys = plan.remove.slice(i, i + batchSize).map((v) => v.key)
    try {
      report.released += await opts.blobs.deleteMany(keys)
    } catch (err) {
      errors.push(`删除失败（${keys.length} 条）：${(err as Error).message}`)
      break
    }
  }
  return report
}

export interface ReclaimerOptions {
  /** 当前存活引用。每次 flush 现取，绝不缓存 —— 缓存就是误删的开始 */
  liveRefs: () => Set<string>
  /** 合并窗口：连续淘汰多条命令时只跑一次删除，默认 800ms */
  debounceMs?: number
  onReclaimed?: (info: { candidates: number; released: number; kept: number }) => void
  /** 测试注入；默认 setTimeout/clearTimeout */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancel?: (handle: ReturnType<typeof setTimeout>) => void
}

/**
 * 增量回收器：只处理"历史丢弃命令"这一路信号。
 *
 * 它**不**负责帧点云（那是 sweep 的活），也**不**负责启动清扫。
 * 这样职责很清楚：编辑过程中实时回收大载荷，切数据集/启动时做全量清扫。
 */
export class BlobReclaimer {
  private pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly debounceMs: number
  private readonly schedule: NonNullable<ReclaimerOptions['schedule']>
  private readonly cancel: NonNullable<ReclaimerOptions['cancel']>

  constructor(
    private readonly blobs: BlobStore | null,
    private readonly opts: ReclaimerOptions,
  ) {
    this.debounceMs = opts.debounceMs ?? 800
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h))
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /** 记录一批"刚失去最后一条命令引用"的键。会去重并排定一次 flush */
  noteDropped(refs: Iterable<string>): void {
    if (this.disposed || !this.blobs) return
    let added = false
    for (const ref of refs) {
      if (!isPayloadRef(ref)) continue
      if (this.pending.has(ref)) continue
      this.pending.add(ref)
      added = true
    }
    if (!added) return
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = this.schedule(() => {
      this.timer = null
      void this.flush()
    }, this.debounceMs)
  }

  /**
   * 立即回收。
   * 关键一步：重新用 liveRefs 判定，而不是相信"刚才通知说没人用了"。
   * 撤销、重做、内容寻址复用都会让被丢弃的键重新变活。
   */
  async flush(): Promise<{ candidates: number; released: number; kept: number }> {
    if (this.timer !== null) {
      this.cancel(this.timer)
      this.timer = null
    }
    const candidates = [...this.pending]
    this.pending.clear()
    if (!candidates.length || !this.blobs) {
      return { candidates: candidates.length, released: 0, kept: candidates.length }
    }

    const live = this.opts.liveRefs()
    const dead = candidates.filter((ref) => !live.has(ref))
    const kept = candidates.length - dead.length
    let released = 0
    if (dead.length) {
      try {
        released = await this.blobs.deleteMany(dead)
      } catch {
        // 删不掉就留在库里，下次 sweep 还会看到它。不重试，不抛错。
        released = 0
      }
    }
    this.opts.onReclaimed?.({ candidates: candidates.length, released, kept })
    return { candidates: candidates.length, released, kept }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      this.cancel(this.timer)
      this.timer = null
    }
    this.pending.clear()
  }
}
