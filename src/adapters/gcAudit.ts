/**
 * ============================================================
 * 适配器：回收审计流
 * ============================================================
 *
 * 【为什么需要它】
 *   `BlobReclaimer` 之前只往 console 打一行"回收了 3 条"。用户看到的现象是
 *   "上周配好的帧缓存今天全空了"，而控制台早已滚过、刷新就没了 ——
 *   没有任何证据能回答"是谁、什么时候、按什么理由删的"。
 *
 *   审计流记的是**判定摘要**，不是每条键：一次清扫一条记录，
 *   包含触发点、扫描数、删除数、字节数、按理由的分布、有多少对端标签页
 *   参与了保护。30 条环形缓冲，几十 KB，够回溯最近的几次"缓存突然变小"。
 *
 * 【为什么放 localStorage 而不是 IndexedDB】
 *   审计只服务于排障，不能因为写审计失败而影响回收；
 *   IndexedDB 要新建 store（版本再 +1），而 localStorage 是同步的、
 *   一条记录几百字节，30 条远不到配额。缺点是可能被用户清浏览器数据带走 ——
 *   那种情况下缓存也已经没了，审计跟着没是合理的。
 */

import { pushCapped } from '../domain/store/tabLease'
import type { EvictionPolicy } from '../domain/store/frameBudget'
import { resolveLocalStorage, type StorageLike } from './tabBus'

/** 触发清扫的入口，和调用点一一对应 */
export type GcTrigger = 'startup' | 'dataset-change' | 'clear-draft' | 'manual' | 'quota'

export interface GcAuditEntry {
  at: number
  tabId: string
  trigger: GcTrigger
  dryRun: boolean
  scanned: number
  released: number
  removeBytes: number
  /** 按判定理由的条数与字节数（只记删掉的与保留的合计，不含每条键） */
  byReason: Record<string, { count: number; bytes: number }>
  /** 参与保护的对端标签页数（0 = 只有本端） */
  peers: number
  /** 本会因为对端引用而免于删除的条数 */
  keptByPeers: number
  /**
   * 其中有多少是"还活着但最久未用"被淘汰的帧（条数与字节）。
   *
   * 【为什么单独记】`byReason` 里已经有 `lru-evicted`，但那个字段是
   * "按理由分组的条数"，看审计的人想知道的往往是更直接的问题：
   * 这次到底是清了垃圾，还是动了我在用的数据。
   */
  lruFrames?: number
  lruBytes?: number
  /**
   * 这次淘汰用的是什么排序（lru / lfu / hybrid）。
   *
   * 【为什么要记】同一个"删了 12 帧"的结论，在三种策略下删的是完全不同的帧。
   * 用户抱怨"我刚看的那帧没了"时，这条字段直接决定该怀疑哪个判据。
   */
  evictPolicy?: EvictionPolicy
  /** 这次淘汰跨了几个数据集（>1 说明动了别的标签页的帧） */
  lruDatasets?: number
  /** 计划腾出的字节仍然不够时的缺口；缺省表示腾够了 */
  shortfallBytes?: number
}

export const GC_AUDIT_KEY = 'lt:gc-audit'
export const GC_AUDIT_LIMIT = 30

function store(custom?: StorageLike | null): StorageLike | null {
  return custom === undefined ? resolveLocalStorage() : custom
}

/** 记一条。失败静默：审计不能反过来影响回收 */
export function recordGcAudit(entry: GcAuditEntry, custom?: StorageLike | null): void {
  const ls = store(custom)
  if (!ls) return
  try {
    const prev = listGcAudit(ls)
    ls.setItem(GC_AUDIT_KEY, JSON.stringify(pushCapped(prev, entry, GC_AUDIT_LIMIT)))
  } catch { /* 配额满/禁用：放弃这条审计 */ }
}

/** 最近的审计（新→旧） */
export function listGcAudit(custom?: StorageLike | null): GcAuditEntry[] {
  const ls = store(custom)
  if (!ls) return []
  try {
    const raw = ls.getItem(GC_AUDIT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    // 防御：手改/旧版本留下的脏数据不该让控制台入口整条崩掉
    return parsed.filter((e): e is GcAuditEntry => !!e && typeof (e as GcAuditEntry).at === 'number')
  } catch {
    return []
  }
}

export function clearGcAudit(custom?: StorageLike | null): void {
  const ls = store(custom)
  try { ls?.removeItem(GC_AUDIT_KEY) } catch { /* 忽略 */ }
}

export interface GcAuditSummary {
  entries: number
  released: number
  removeBytes: number
  /** 最近 30 次里因为配额压力被淘汰的帧数 */
  lruFrames: number
  /** 按标签页分组：同一个用户开两个标签页时能看出是哪一个删的 */
  byTab: Array<{ tabId: string; released: number; bytes: number }>
  /** 最近一次的时间戳；没有记录时为 0 */
  lastAt: number
}

/**
 * 汇总：`studio.gcAudit()` 默认返回原始记录，控制台想看"总共删了多少"再看这个。
 * 不按时间窗口切分 —— 环形缓冲本身就只有最近 30 次。
 */
export function summarizeGcAudit(entries: GcAuditEntry[]): GcAuditSummary {
  const byTab = new Map<string, { released: number; bytes: number }>()
  let released = 0
  let removeBytes = 0
  let lruFrames = 0
  for (const e of entries) {
    released += e.released
    removeBytes += e.removeBytes
    lruFrames += e.lruFrames ?? 0
    const slot = byTab.get(e.tabId) ?? { released: 0, bytes: 0 }
    slot.released += e.released
    slot.bytes += e.removeBytes
    byTab.set(e.tabId, slot)
  }
  return {
    entries: entries.length,
    released,
    removeBytes,
    lruFrames,
    byTab: [...byTab.entries()].map(([tabId, v]) => ({ tabId, ...v })).sort((a, b) => b.bytes - a.bytes),
    lastAt: entries[0]?.at ?? 0,
  }
}
