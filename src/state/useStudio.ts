/**
 * ============================================================
 * 工作台装配层
 * ============================================================
 * 这里只做五件事：创建 core、装配五个功能模块、绑定 viewer 与 DOM 事件、
 * 按 URL / 本地草稿决定启动数据集、驱动自动保存。
 * 业务实现分别在：
 *   studioCore        共享状态 / 历史栈 / 渲染同步
 *   useAnnotation     画框、框编辑、撤销重做、导入导出
 *   useDataset        演示 / 真实数据 / 多帧导入 / 草稿恢复
 *   useSequence       帧切换、回放、插值、跨帧传播、时序质检
 *   useQuality        质检报告、关联演示、百万点压测
 *   useCameraDirector 关键帧、运镜播放、WebM 录制
 */
import { onMounted, onBeforeUnmount, nextTick, ref, toRaw, watch } from 'vue'
import { PointCloudViewer } from '../viewer/PointCloudViewer'
import { issueTypeName } from '../core/sequence/temporalQA'
import {
  clearSession, estimateSnapshotBytes, loadDraftPointer, loadSession, saveSession, toStoredCloud,
} from '../core/io/session'
import type { StoredCloud } from '../core/io/session'
import { studioStore } from '../adapters/studioStore'
import { clearDatasetClouds } from '../adapters/frameCloudStore'
import { BlobReclaimer } from '../adapters/blobGc'
import { formatBytes, runStoreGc } from '../adapters/studioGc'
import type { StoreGcResult } from '../adapters/studioGc'
import type { FrameBudget } from '../adapters/blobGc'
import { frameBlobKey } from '../adapters/blobKeys'
import {
  DEFAULT_EVICTION_POLICY, EVICTION_POLICY_LABEL, isEvictionPolicy, neighborhoodKeys,
  type EvictionPolicy, type FrameEvictionPlan,
} from '../domain/store/frameBudget'
import { flushFrameUse } from '../adapters/frameCloudStore'
import { tabBus } from '../adapters/tabBus'
import type { PeerProtection } from '../domain/store/tabLease'
import { clearGcAudit, listGcAudit, recordGcAudit, summarizeGcAudit, type GcTrigger } from '../adapters/gcAudit'
import type { Box3D, ObjectCategory, PointCloud } from '../core/types'
import { createStudioCore, numVal, strVal } from './studioCore'
import { useAnnotation } from './useAnnotation'
import { useDataset } from './useDataset'
import { useSequence } from './useSequence'
import { useQuality } from './useQuality'
import { useCameraDirector } from './useCameraDirector'
import { useLibrary } from './useLibrary'
import { usePreAnnotation } from './usePreAnnotation'
import { useTasks } from './useTasks'
import { useVla } from './useVla'
import type { Command } from '../domain/model/command'
import { nextNumericId } from '../domain/model/ids'

export function useStudio() {
  const core = createStudioCore()
  const annotation = useAnnotation(core)
  const dataset = useDataset(core)
  const sequence = useSequence(core)
  const quality = useQuality(core)
  const camera = useCameraDirector(core)

  const showHelp = ref(false)
  const menuOpen = ref(false)

  /**
   * 大载荷回收器：历史条目被淘汰时收通知。
   *
   * 它拿到的只是"这条命令没人用了"，删不删由 `liveRefs()` 现算 ——
   * 内容寻址会让多个命令引用同一份 blob，仅凭一次释放通知就删必然出事。
   * 帧点云不归它管：那是 `runBlobGc` 的全量清扫（判据是数据集而不是引用）。
   */
  const reclaimer = new BlobReclaimer(studioStore()?.blobs ?? null, {
    liveRefs: () => core.store.value?.liveBlobRefs() ?? new Set<string>(),
    onReclaimed: ({ released }) => {
      if (released > 0) console.info(`[blob-gc] 历史淘汰回收 ${released} 条载荷`)
    },
  })

  // store 每次 rebuildDocument 都会换实例，订阅随之换到新实例上（旧实例的钩子随对象回收）
  watch(core.store, (s) => {
    s?.onCommandDropped((refs) => reclaimer.noteDropped(refs))
  }, { immediate: true })

  /**
   * 文档换了（装载 / 恢复 / 换数据集）就重新申请租约。
   * 用 sampleId 而不是 docVersion：后者每个命令都变，会让 claim 每次编辑都跑一遍。
   */
  watch(() => core.doc.value?.sampleId ?? '', (id) => { void refreshLease(id) })

  /* ------------------------------------------------------------------
   * 跨标签页协调
   * ------------------------------------------------------------------
   * 三件事，对应三个会互相踩的地方（详见 adapters/tabBus.ts）：
   *   1. 样本租约 —— 同一样本只允许一个标签页写；没抢到的转只读
   *   2. 引用广播 —— 清扫前问一圈对端，别删掉人家还没落盘的载荷
   *   3. presence —— 状态栏/排障能看到"这个样本还有谁开着"
   */
  const bus = tabBus()
  /** 对端标签页快照（状态栏 chip 与排障用） */
  const peerTabs = ref<ReturnType<typeof bus.peers>>([])
  let leaseSettled = ''

  function syncPeerTabs() { peerTabs.value = bus.peers() }

  /**
   * 申请当前样本的写权。样本 id 变了就要重新申请：
   * 换数据集等于换了一份文档，上一份的租约没有意义。
   *
   * `leaseSettled` 记录已经判定过的样本，避免同一份文档因为多次
   * rebuildDocument（改一个框不会，但装载会）反复申请。
   */
  async function refreshLease(sampleId: string): Promise<void> {
    if (!sampleId) {
      bus.release()
      core.readOnly.value = false
      if (core.saveState.value === 'readonly') core.saveState.value = 'idle'
      leaseSettled = ''
      return
    }
    if (leaseSettled === sampleId) return
    leaseSettled = sampleId
    const res = await bus.claim(sampleId)
    // 期间样本又变了：这次结果作废（否则会把 B 的租约状态写到 A 上）
    if (leaseSettled !== sampleId) return
    syncPeerTabs()
    if (!res.supported) {
      // 没有 localStorage（隐私模式/测试环境）：退回改造前的行为
      core.readOnly.value = false
      return
    }
    if (res.ok) {
      core.readOnly.value = false
      core.readOnlyNote.value = ''
      if (core.saveState.value === 'readonly') core.saveState.value = 'idle'
      return
    }
    core.readOnly.value = true
    core.readOnlyNote.value = `只读：样本正由另一个标签页（${res.holder}）编辑 · 点此接管`
    core.saveState.value = 'readonly'
    core.statusText.value = core.readOnlyNote.value
  }

  /**
   * 接管编辑权。用户在状态栏点"接管"时调用 ——
   * 这是显式动作，所以不排队、不询问：他知道另一个标签页在编辑。
   */
  async function takeoverScene(): Promise<boolean> {
    const sampleId = core.doc.value?.sampleId
    if (!sampleId) return false
    const res = bus.takeover(sampleId)
    if (!res.ok) {
      core.statusText.value = '当前环境不支持跨标签页协调，无法接管'
      return false
    }
    core.readOnly.value = false
    core.readOnlyNote.value = ''
    core.saveState.value = 'idle'
    syncPeerTabs()
    core.statusText.value = '已接管该样本的编辑权（另一个标签页已转为只读）'
    return true
  }

  /** 回收审计：`studio.gcAudit()` 看原始记录 + 汇总 */
  function gcAudit() {
    const entries = listGcAudit()
    return { entries, summary: summarizeGcAudit(entries) }
  }

  function clearGcAuditLog(): void {
    clearGcAudit()
    core.statusText.value = '回收审计已清空'
  }

  /**
   * Web Locks：让两个标签页的清扫排队。
   * 不排队也不会删错（判定是幂等的），但会互相把对方的"当前状态"
   * 当成已完成，导致两边都以为删干净了、实际各删一半。
   * 不支持时直接跑 —— 这只影响效率，不影响正确性。
   */
  function withGcLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = (typeof navigator !== 'undefined'
      ? (navigator as Navigator & { locks?: { request<R>(name: string, cb: () => Promise<R>): Promise<R> } }).locks
      : undefined)
    if (!locks?.request) return fn()
    try {
      return locks.request('label-tool/blob-gc', fn)
    } catch {
      return fn()
    }
  }

  /**
   * 配额自救的两个水位。
   *
   * `TRIGGER` 与 `persistNow()` 里的预警阈值一致 —— 两个地方用不同的数字，
   * 就会出现"它说快满了但不清扫""它清扫了却说没事"。
   * `TARGET` 留出 15% 的余量：只腾到刚好 85% 的话，用户再标十帧又满了，
   * 于是每次保存都触发一次淘汰，帧缓存持续抖动。
   */
  const QUOTA_TRIGGER = 0.85
  const QUOTA_TARGET = 0.7

  /**
   * 帧缓存淘汰策略。
   *
   * 【为什么做成可切换而不是写死一种】三种排序解决的是不同场景：
   * 顺序回看（lru）、反复回看少数重点帧（lfu）、两者混合（默认）。
   * 哪种更合适取决于用户的标注习惯，代码替用户拍板没有依据，
   * 所以给一个能改的开关 —— 但**不放进界面**：这是存储策略，
   * 摆在菜单里只会让用户以为需要关心它。入口是 `?evict=` 与 `studio.setEvictionPolicy()`。
   *
   * 选择存在 localStorage：刷新后用户的选择不该被悄悄改回默认。
   */
  const POLICY_KEY = 'lt:evict-policy'

  function readStoredPolicy(): EvictionPolicy {
    try {
      const raw = localStorage.getItem(POLICY_KEY)
      if (isEvictionPolicy(raw)) return raw
    } catch { /* 隐私模式：退回默认 */ }
    return DEFAULT_EVICTION_POLICY
  }

  const evictionPolicy = ref<EvictionPolicy>(readStoredPolicy())

  function setEvictionPolicy(next: EvictionPolicy): void {
    if (!isEvictionPolicy(next)) return
    evictionPolicy.value = next
    try { localStorage.setItem(POLICY_KEY, next) } catch { /* 存不了就只在本次会话生效 */ }
    core.statusText.value = `帧缓存淘汰策略：${EVICTION_POLICY_LABEL[next]}（下次配额清扫生效）`
  }

  /** 当前帧及其前后各两帧的键：淘汰绝不能动这些 */
  function protectedFrameKeys(): string[] {
    const key = core.datasetKey.value
    if (!key) return []
    return neighborhoodKeys(key, core.currentFrame.value, (ds, f) => [
      frameBlobKey(ds, f),
      frameBlobKey(ds, f, 'colors'),
      frameBlobKey(ds, f, 'labels'),
    ])
  }

  /**
   * 组装一次淘汰预算。返回 undefined 表示"没有一个可动的数据集"。
   *
   * 【全局候选池怎么来的】
   *   本端可淘汰 = 当前数据集能重新解码（`framesReloadable`）。
   *   对端可淘汰 = 对端在 `refs:res` 里自报 `evictable` 的数据集。
   *   两者取并集，跨数据集统一排序 —— 谁最久没用就先删谁，
   *   而不是"先把本端的删完、不够再说"。
   *
   * 【为什么 own 的 evictable 只信本端】同一个 datasetKey 可能一边是刚导入的
   *   File（能重解）、一边是恢复草稿的缓存句柄（缓存是唯一副本）。
   *   本端若拿着缓存句柄，就不能因为对端说"我能重解"而删掉本端唯一的副本。
   *   所以对端声明的集合里要把 own 剔掉。
   */
  function assembleBudget(reclaimBytes: number, protection: PeerProtection | null): FrameBudget | undefined {
    const own = core.datasetKey.value
    const evictable = new Set<string>()
    if (own && dataset.canEvictFrames()) evictable.add(own)
    for (const key of protection?.evictableDatasetKeys ?? []) {
      if (key && key !== own) evictable.add(key)
    }
    if (!evictable.size) return undefined
    return {
      reclaimBytes,
      evictableDatasetKeys: [...evictable],
      // 本端邻域 + 对端自报邻域：谁的数据集谁提供保护键，互不猜测
      protectKeys: [...protectedFrameKeys(), ...(protection?.protectKeys ?? [])],
      policy: evictionPolicy.value,
    }
  }

  /**
   * 配额压力预算。返回 undefined 表示"不该动活帧"。
   *
   * 两个前提缺一不可：
   *   1. 真的快满了（>85%）—— 平时淘汰活帧是纯负收益，只会让用户多等解码；
   *   2. 至少有一个可淘汰的数据集（本端或对端）。
   *
   * 【为什么不要求"本端必须可淘汰"】那正是 23.11 第 1 条的问题：
   * 本端开着 3 帧的演示数据、库里却压着另一个标签页的 2GB 时，
   * 旧逻辑直接返回 undefined，配额永远降不下来。现在只要对端能重解就动对端。
   */
  async function buildLruBudget(protection: PeerProtection | null): Promise<FrameBudget | undefined> {
    const store = studioStore()
    if (!store) return undefined
    const usage = await store.blobs.usage().catch(() => null)
    if (!usage || usage.quota <= 0) return undefined
    if (usage.used / usage.quota <= QUOTA_TRIGGER) return undefined
    const reclaimBytes = Math.ceil(usage.used - usage.quota * QUOTA_TARGET)
    if (reclaimBytes <= 0) return undefined
    return assembleBudget(reclaimBytes, protection)
  }

  /** 上一次清扫时的数据集键：用来判断"草稿指针是否换了目标" */
  let lastGcDatasetKey: string | null = null
  /** 正在跑的清扫。手动调用会排队等它，后台触发则直接让路 */
  let gcInFlight: Promise<StoreGcResult | null> | null = null

  /**
   * 预算来源：默认按配额算，手测可强制指定差额。
   *
   * 【为什么留一个强制入口】配额阈值（85%）在正常机器上要写满几个 GB 才能触发，
   * 手测与回归根本造不出来。`reclaimBytes` 让调用方直接说"腾这么多"，
   * 走的仍是同一条判定链（保护当前帧邻域、只碰可重解码的数据集）。
   *
   * 注意它**绕过**了 `canEvictFrames()` 与配额判定：这个入口只挂在 DEV 的
   * `window.studio` 上，生产包里没有，不会被用户误触。
   */
  async function resolveBudget(
    opts: { reclaimBytes?: number },
    protection: PeerProtection | null,
  ): Promise<FrameBudget | undefined> {
    const forced = opts.reclaimBytes ?? 0
    if (forced > 0) return assembleBudget(forced, protection)
    return buildLruBudget(protection)
  }

  /** 淘汰说明：状态栏与预演共用一段文案，避免两处说法不一致 */
  function describeEviction(plan?: FrameEvictionPlan): string {
    if (!plan) return ''
    const short = plan.shortfall > 0 ? `，仍差 ${formatBytes(plan.shortfall)}` : ''
    if (!plan.groups.length) return short ? `；可淘汰的帧不够${short}，建议导出后清理旧草稿` : ''
    const cross = plan.datasets.length > 1 ? `、跨 ${plan.datasets.length} 个数据集` : ''
    return `，配额淘汰 ${plan.groups.length} 帧（${formatBytes(plan.bytes)}${cross}${short}）`
      + `，策略${EVICTION_POLICY_LABEL[plan.policy]}，切回会重新解码`
  }

  /**
   * 淘汰完成后把"谁该撤回记账"分清楚。
   *
   * 本端的帧：直接撤销记账（快照会退回内联）。
   * 对端的帧：**广播通知**对端自己撤 —— 它的 `persistedFrames` 只在它内存里，
   * 不通知就会写出一份乐观的 spill 快照，刷新后点云全空。
   */
  function settleEvictions(plan: FrameEvictionPlan | undefined): void {
    if (!plan) return
    const own = core.datasetKey.value
    const ownFrames: Array<{ frame: number; bytes: number }> = []
    const foreign = new Map<string, Array<{ frame: number; bytes: number }>>()
    for (const group of plan.groups) {
      const item = { frame: group.frame, bytes: group.bytes }
      if (own && group.datasetKey === own) ownFrames.push(item)
      else {
        const list = foreign.get(group.datasetKey) ?? []
        list.push(item)
        foreign.set(group.datasetKey, list)
      }
    }
    if (ownFrames.length) dataset.forgetPersistedFrames(ownFrames)
    for (const [datasetKey, frames] of foreign) {
      const bytes = frames.reduce((n, f) => n + f.bytes, 0)
      bus.announceFramesEvicted(datasetKey, frames, bytes)
    }
  }

  /** 真正扫一遍。调用前已保证没有并发清扫，这里只负责"扫 + 记 + 说" */
  async function sweepOnce(
    opts: { manual?: boolean; dryRun?: boolean; reclaimBytes?: number },
    trigger: GcTrigger,
  ): Promise<StoreGcResult | null> {
    return withGcLock(async () => {
      // 顺序不能反：先问对端要引用，再枚举库。
      // 反过来的话，对端可能正好在"我们枚举完"与"它写下一条载荷"之间插进来。
      const protection = await bus.collectPeerRefs().catch(() => null)
      // 读路径攒下的使用时间先落库：否则这次清扫看到的是"上次 flush 之前"的 LRU 顺序，
      // 刚看过的帧可能被当成最久未用
      await flushFrameUse().catch(() => 0)
      const budget = await resolveBudget(opts, protection)
      const report = await runStoreGc({
        livePayloadRefs: core.store.value?.liveBlobRefs() ?? [],
        activeDatasetKey: core.datasetKey.value || undefined,
        peerPayloadRefs: protection?.payloadRefs,
        peerDatasetKeys: protection?.datasetKeys,
        peers: protection?.responders ?? 0,
        budget,
        dryRun: opts.dryRun,
      })
      if (!report) {
        if (opts.manual) core.statusText.value = '当前环境不支持本地缓存回收'
        return null
      }
      if (report.errors.length) console.warn('[blob-gc]', report.errors)

      // 淘汰的是"还活着的数据集"的帧，记账必须跟着撤：
      // 否则 canSpillClouds() 仍以为能回读，快照写 spill，恢复时整片点云是空的
      const evicted = report.lru?.groups ?? []
      if (evicted.length && !opts.dryRun) settleEvictions(report.lru)

      // 预演也记审计：否则"预演过但没真删"和"根本没跑"分不清
      recordGcAudit({
        at: Date.now(),
        tabId: bus.tabId,
        trigger,
        dryRun: !!opts.dryRun,
        scanned: report.scanned,
        released: report.released,
        removeBytes: report.removeBytes,
        byReason: report.byReason as Record<string, { count: number; bytes: number }>,
        peers: report.peers,
        keptByPeers: report.peerProtected,
        ...(report.lru
          ? {
              evictPolicy: report.lru.policy,
              lruFrames: evicted.length,
              lruBytes: report.lru.bytes,
              lruDatasets: report.lru.datasets.length,
              ...(report.lru.shortfall > 0 ? { shortfallBytes: report.lru.shortfall } : {}),
            }
          : {}),
      })

      const peerNote = report.peerProtected
        ? `，${report.peerProtected} 条因其它标签页在用而保留`
        : ''
      const lruNote = describeEviction(report.lru)

      if (opts.dryRun) {
        const msg = `预演：可回收 ${formatBytes(report.removeBytes)}（${report.remove.length} 条），`
          + `保留 ${report.scanned - report.remove.length} 条${peerNote}${lruNote}`
        if (opts.manual) core.statusText.value = msg
        else console.info('[blob-gc]', msg, report.byReason)
        return report
      }

      lastGcDatasetKey = core.datasetKey.value || null
      if (report.released > 0) {
        const msg = `已回收 ${formatBytes(report.removeBytes)} 本地缓存（${report.released} 条）${peerNote}${lruNote}`
        if (opts.manual) core.statusText.value = msg
        else console.info('[blob-gc]', msg, report.byReason)
      } else if (opts.manual) {
        core.statusText.value = `本地缓存已是最简：扫描 ${report.scanned} 条，无需回收${peerNote}${lruNote}`
      }
      return report
    })
  }

  /**
   * 全量清扫：帧缓存按"数据集是否还活着"判定，载荷按"引用是否还活着"判定。
   * 只在三类时机跑：启动后、草稿指针换了目标、用户手动清理。
   * 每次自动保存都跑会把 IndexedDB 的游标读满，反而拖慢编辑。
   *
   * 返回报告，方便控制台直接看判定明细（`studio.runBlobGc()` 的返回值里
   * 有 `verdicts` / `byReason`，能回答"为什么这条被删了"）。
   * `dryRun: true` 只出计划不落删，用于手测与排障。
   *
   * 并发：后台触发（启动/换数据集/配额）撞上正在跑的清扫就放弃 ——
   * 它要的是"待会儿会扫"；手动触发则排队等前一次跑完再跑，
   * 因为控制台里返回 null 等于"没反应"。
   */
  async function runBlobGc(
    opts: { manual?: boolean; dryRun?: boolean; trigger?: GcTrigger; reclaimBytes?: number } = {},
  ): Promise<StoreGcResult | null> {
    while (gcInFlight) {
      if (!opts.manual) return null
      await gcInFlight.catch(() => null)
    }
    const trigger: GcTrigger = opts.trigger ?? (opts.manual ? 'manual' : 'startup')
    const task = sweepOnce(opts, trigger).catch((err) => {
      if (opts.manual) core.statusText.value = `缓存回收失败：${(err as Error).message}`
      return null
    })
    gcInFlight = task
    try {
      return await task
    } finally {
      if (gcInFlight === task) gcInFlight = null
    }
  }

  /**
   * 样本列表（本地落盘文档的浏览与删除）。
   *
   * 21.6 决定"不做自动 prune"，那就必须有一条手动出口 —— 否则 documents 只进不出，
   * 用户除了清浏览器数据没有别的办法。
   *
   * 三个依赖各自对应一条真实约束：
   *   - `currentSampleId`：当前样本不能删（删了下次自动保存又写回来）
   *   - `heldByOtherTab`：别人正持有租约的不能删（删了对端静默丢写，且会重建回来）
   *   - `afterRemove`：删完立刻扫一遍，让"删了但空间没变"这件事不发生
   */
  const library = useLibrary({
    currentSampleId: () => core.doc.value?.sampleId ?? '',
    heldByOtherTab: (sampleId) => {
      const lease = bus.leaseOf(sampleId)
      return lease && lease.tabId !== bus.tabId ? lease.tabId : null
    },
    afterRemove: async () => {
      const report = await runBlobGc({ manual: true, trigger: 'manual' })
      if (!report || report.released <= 0) return ''
      return `已回收 ${formatBytes(report.removeBytes)} 缓存（${report.released} 条）`
    },
    say: (msg) => { core.statusText.value = msg },
  })

  /**
   * 执行一条"跨帧的大命令"（预标注合并、复核裁决）。
   *
   * 【为什么单独抽出来】这几步顺序是硬性的：先 exec 改真值，再刷新镜像，
   * 再重算当前帧视图，最后才 syncViewer / markDirty。任何一处顺序颠倒
   * 都会出现"画面上是旧的、导出是新的"或"没触发自动保存"。
   * 各处业务代码自己写这五行，迟早会漏一步。
   */
  function applyEdit(cmd: Command): void {
    const s = core.store.value
    if (!s) return
    s.exec(cmd)
    core.refreshFrameBoxes(cmd.meta.affects.frames)
    core.boxes.value = core.materializeNow()
    core.pruneSelection()
    core.syncHistoryUi()
    core.syncViewer()
    core.markDirty()
  }

  /**
   * 预标注与复核。
   *
   * 依赖显式列出而不是把 core 整个传进去：这段功能的边界就是
   * "读文档 / 写命令 / 跳帧 / 选中"，不需要别的。
   */
  const preAnnotation = usePreAnnotation({
    doc: () => core.doc.value,
    range: () => core.doc.value?.range ?? [0, -1],
    totalFrames: () => core.frames.value.length,
    currentFrame: () => core.frameNumber(),
    nextTrackId: (used) => {
      // used 里既有库里已有的 id，也有"本次合并刚分配但还没落库"的 id。
      // 两个集合取并再算，才能一次合并建多条时不会撞号
      const all = new Set(used)
      for (const t of core.store.value?.tracks ?? []) all.add(t.id)
      for (const b of core.boxes.value) all.add(b.id)
      return nextNumericId(all)
    },
    applyEdit,
    gotoFrame: (frame) => sequence.gotoFrameIndex(frame),
    selectTrack: (id) => {
      core.selectMany([id])
      core.syncViewer()
    },
    cloud: () => core.cloud.value,
    say: (msg) => { core.statusText.value = msg },
  })

  /**
   * 文档变化（别的入口的撤销、删除、改类别）之后，复核队列要跟着重算。
   *
   * 只在面板打开时算：关闭时没人看这两个数，而 `collectReviewRows` 要扫全部
   * 轨迹的 states —— 拖框时每帧都扫一遍会白烧 CPU。
   */
  watch(core.docVersion, () => {
    if (preAnnotation.reviewOpen.value) preAnnotation.refresh()
  })

  /**
   * 多任务（P3）：占据派生 / 光流 / 跨任务一致性。
   *
   * 它和预标注共享同一条 `applyEdit`：大载荷写入也必须是可撤销的命令，
   * 否则"改了一帧占据，撤销只撤回来框"会让两份真值永久错位。
   */
  const tasks = useTasks(core, {
    applyEdit,
    blobs: () => studioStore()?.blobs ?? null,
    say: (msg) => { core.statusText.value = msg },
    gotoFrame: (frame) => sequence.gotoFrameIndex(frame),
  })

  /**
   * VLA（P4）：指令段 / 动作通道 / 对齐校验。
   *
   * 与 tasks 分开而不是塞进 useTasks：VLA 的载荷在文档里（不走 BlobStore），
   * 编辑粒度是"整份替换"，校验需要自己的选项与符号约定 —— 除了"都要 applyEdit"
   * 这一条，两者没有共享的状态。合成一个 900 行的文件只会让两边都难改。
   */
  const vla = useVla(core, {
    applyEdit,
    say: (msg) => { core.statusText.value = msg },
    gotoFrame: (frame) => sequence.gotoFrameIndex(frame),
  })

  /**
   * 复核快捷键的先行拦截。
   *
   * 用捕获阶段是因为 `annotation.onKeyDown` 注册在同一节点（window）的冒泡阶段：
   * 捕获阶段先跑，`stopPropagation()` 之后冒泡那一路就不再执行。
   * 只有面板打开时 `handleKey` 才返回 true，其余情况这条监听器等于不存在。
   */
  function onReviewKey(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (!preAnnotation.handleKey(e)) return
    e.preventDefault()
    e.stopPropagation()
  }

  let saveTimer: number | undefined
  let saving = false
  /** 撤销"对端淘汰了本端帧"的订阅 */
  let offFramesEvicted: (() => void) | null = null
  /** 视口 DOM 上的监听器回收器：卸载时统一摘掉，避免画布已 dispose 仍在被调用 */
  const viewportCleanup: (() => void)[] = []

  /**
   * IndexedDB 的结构化克隆不接受 Vue 的响应式 Proxy（会抛 DataCloneError），
   * 所以落盘前必须把数据剥回原始对象：框/类别用 JSON 深拷贝，点云取 toRaw。
   */
  function plainBoxes(list: Box3D[]): Box3D[] {
    return JSON.parse(JSON.stringify(list)) as Box3D[]
  }

  function storedCloud(cloud: PointCloud) {
    const raw = toRaw(cloud)
    const stored = toStoredCloud({
      positions: toRaw(raw.positions),
      count: raw.count,
      ...(raw.colors ? { colors: toRaw(raw.colors) } : {}),
      ...(raw.labels ? { labels: toRaw(raw.labels) } : {}),
      ...(raw.semanticClasses ? { semanticClasses: JSON.parse(JSON.stringify(raw.semanticClasses)) } : {}),
    })
    return stored
  }

  /** 快照里点云的字节上限：超过就不再往 v1 快照里塞，交给 blob store */
  const SNAPSHOT_CLOUD_BUDGET = 80 * 1024 * 1024
  const EMPTY_CLOUD: StoredCloud = { positions: new Float32Array(0), count: 0 }

  /**
   * 组织快照：先把真值刷新到 frames 镜像，避免落盘的是旧框。
   *
   * 【点云怎么存：两档】
   *   1. `spill`（可回读）：每个解码帧都已确认写进 blob store，快照只留
   *      **封面帧（第 0 帧）+ 当前帧**，其余帧写空点云 + `lazy: true`。
   *      500 帧数据集因此从"几百 MB 直接放弃自动保存"变成"几十 KB"。
   *   2. `inline`（回读不保证）：点云照旧塞进快照，受 80MB 预算约束。
   *      演示数据、单帧导入、或落盘失败的帧走这条 —— 宁可快照大，不能丢。
   *
   *   为什么非要留封面帧和当前帧：恢复后首屏必须有画面，而当前帧是用户
   *   关标签页时正在看的那一帧，恢复后直接空掉等于"回来找不到刚才的位置"。
   *
   * 【标注真值不在这里】
   *   boxes 仍写一份，但只作 v1 兜底；恢复优先读 v2 文档（见 restoreFromDocument）。
   */
  function buildSnapshot() {
    core.refreshFrameBoxes()
    const datasetKey = core.datasetKey.value
    const spill = dataset.canSpillClouds()
    const keepIndexes = spill ? new Set([0, core.currentFrame.value]) : null
    let cloudBudget = SNAPSHOT_CLOUD_BUDGET

    const frames = core.frames.value.map((f, i) => {
      const decoded = f.cloud.count > 0
      const bytes = f.cloud.positions.byteLength + (f.cloud.colors?.byteLength ?? 0)
      const keep = decoded && (keepIndexes
        ? keepIndexes.has(i)
        : (!datasetKey || bytes <= cloudBudget))
      if (keep) cloudBudget -= bytes
      return {
        index: f.index,
        cloud: keep ? storedCloud(f.cloud) : EMPTY_CLOUD,
        boxes: plainBoxes(f.boxes),
        ...(keep ? {} : { lazy: true }),
      }
    })

    return {
      datasetName: core.datasetName.value,
      ...(datasetKey ? { datasetKey } : {}),
      ...(core.doc.value ? { sampleId: core.doc.value.sampleId } : {}),
      cloudMode: spill ? 'spill' as const : 'inline' as const,
      cloud: core.cloud.value && !core.frames.value.length ? storedCloud(core.cloud.value) : null,
      frames,
      currentFrame: core.currentFrame.value,
      boxes: plainBoxes(core.boxes.value),
      categories: JSON.parse(JSON.stringify(core.categories.value)) as ObjectCategory[],
    }
  }

  /**
   * 文档落盘（v2）。与 v1 快照双写：
   *   v2 文档只存真值（几十 KB），用于"标注永不丢"；
   *   v1 快照仍负责恢复时的点云与 UI 状态。
   * 文档写失败不影响草稿保存 —— 它此时还是"附加保障"，不是唯一来源。
   */
  async function persistDocument() {
    const doc = core.doc.value
    const store = studioStore()
    if (!doc || !store) return
    try {
      await store.documents.save(doc)
    } catch { /* 配额不足等情况由草稿保存的提示统一暴露 */ }
  }

  async function persistNow(manual = false) {
    if (saving) return
    // 只读形态绝不写：这里是最关键的一道闸。装载/恢复会把 saveState 标脏，
    // 自动保存照常触发 —— 若不在入口拦住，只读标签页一打开就会把对方的文档覆盖掉。
    if (core.readOnly.value) {
      core.saveState.value = 'readonly'
      if (manual) core.statusText.value = core.readOnlyNote.value || '当前为只读，未写入本地'
      return
    }
    if (!core.cloud.value) return
    const snapshot = buildSnapshot()
    const bytes = estimateSnapshotBytes(snapshot)
    // 超过 80MB 时 IndexedDB 写入会明显卡顿，宁可提示用户手动导出
    if (bytes > 80 * 1024 * 1024) {
      core.saveState.value = 'error'
      if (manual) core.statusText.value = '数据超过 80MB，自动保存已跳过，请手动导出'
      return
    }
    saving = true
    core.saveState.value = 'saving'
    try {
      await saveSession(snapshot)
      await persistDocument()
      core.saveState.value = 'saved'
      core.lastSavedAt.value = Date.now()
      if (manual) core.statusText.value = '草稿已保存到本地（IndexedDB）'

      // 草稿指针刚刚指向当前数据集 —— 上一个数据集的帧缓存此刻才真正变成垃圾。
      // 保存路径上只做"指针变了"这一种触发，避免每次自动保存都全量扫库。
      const key = core.datasetKey.value || null
      if (key && key !== lastGcDatasetKey) void runBlobGc({ trigger: 'dataset-change' })

      // 配额预警：接近上限时提前提示，而不是等写入失败才报错。
      // 旧实现是"超过 80MB 直接跳过"，用户只知道"没保存"，不知道为什么。
      const store = studioStore()
      const usage = await store?.blobs.usage()
      if (usage && usage.quota > 0 && usage.used / usage.quota > 0.85) {
        // 先自己想办法：垃圾回收能收的（旧数据集帧缓存、死载荷）本来就不该占着。
        // 收完还超才提示用户 —— 提示是最后手段，不是第一反应。
        const report = await runBlobGc({ trigger: 'quota' })
        const after = await store?.blobs.usage()
        const pct = (u?: { used: number; quota: number }) => (u && u.quota > 0 ? u.used / u.quota : 0)
        if (pct(after) > 0.85) {
          const usedMb = ((after?.used ?? usage.used) / 1048576).toFixed(0)
          const quotaMb = ((after?.quota ?? usage.quota) / 1048576).toFixed(0)
          core.statusText.value = `本地存储已用 ${usedMb}/${quotaMb}MB，接近浏览器上限；建议导出后清理旧草稿`
        } else if (report?.released) {
          core.statusText.value = `本地存储接近上限，已自动回收 ${formatBytes(report.removeBytes)}（${report.released} 条）`
        }
      }
    } catch (err) {
      core.saveState.value = 'error'
      core.statusText.value = `草稿保存失败：${(err as Error).message}`
    } finally {
      saving = false
    }
  }

  function scheduleSave() {
    if (!core.autosaveEnabled.value) {
      core.saveState.value = 'off'
      return
    }
    if (saveTimer) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => { void persistNow() }, 1200)
  }

  watch(core.dirtyVersion, scheduleSave)

  watch(core.autosaveEnabled, (on) => {
    if (on) scheduleSave()
    else {
      if (saveTimer) window.clearTimeout(saveTimer)
      core.saveState.value = 'off'
    }
  })

  async function clearDraft() {
    try {
      // v2 文档必须一起删：doc-first 恢复优先读文档，只清 v1 快照的话
      // 用户点"清除草稿"后一刷新，框会原样回来（看起来像清除失败）。
      const sampleId = core.doc.value?.sampleId
      await clearSession()
      if (sampleId) await studioStore()?.documents.remove(sampleId)
      // 草稿与逐帧点云缓存是一个整体：只清快照会留下几百 MB 孤儿 blob
      if (core.datasetKey.value) await clearDatasetClouds(core.datasetKey.value)
      core.lastSavedAt.value = null
      core.saveState.value = 'idle'
      core.statusText.value = '已清除本地草稿'
      // 别处（上一次会话、别的数据集）遗留的 blob 也一起收掉
      await runBlobGc({ trigger: 'clear-draft' })
    } catch (err) {
      core.statusText.value = `清除草稿失败：${(err as Error).message}`
    }
  }

  /** 离开页面前兜底保存：浏览器只允许同步提示，保存动作仍走异步但通常来得及 */
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (core.saveState.value === 'dirty') {
      void persistNow()
      e.preventDefault()
      e.returnValue = ''
    }
  }

  function onResizeShortcut(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (e.key === 'F1' || (e.key === '?' && !e.shiftKey)) {
      e.preventDefault()
      showHelp.value = !showHelp.value
    }
    if (e.key === 'Escape') {
      showHelp.value = false
      menuOpen.value = false
    }
  }

  onMounted(async () => {
    await nextTick()
    if (!core.viewportRef.value) return

    // 总线先起：装载/恢复一结束就会申请租约，晚起一拍就会漏掉第一次
    bus.start(() => ({
      sampleId: core.doc.value?.sampleId ?? '',
      datasetKey: core.datasetKey.value,
      payloadRefs: [...(core.store.value?.liveBlobRefs() ?? [])],
      // 自报"我的帧能不能被你淘汰"与"别动我这几个键"：
      // 全局淘汰要靠这两条，缺一个就只能退回"各清各的"
      evictable: dataset.canEvictFrames(),
      protectKeys: protectedFrameKeys(),
    }))
    bus.onLeaseLost(() => {
      core.readOnly.value = true
      core.readOnlyNote.value = '只读：另一个标签页已接管该样本'
      core.saveState.value = 'readonly'
      core.statusText.value = core.readOnlyNote.value
    })
    /**
     * 别的标签页按配额淘汰了本端的帧 —— 必须撤回记账。
     *
     * 撤回之后快照退回内联：文件大一点，但刷新后点云还在。
     * 不撤的话，`canSpillClouds()` 仍为 true，写出只留封面帧的快照，
     * 那些帧在库里已经没了，恢复时整片空白。
     */
    offFramesEvicted = bus.onFramesEvicted((notice) => {
      const own = core.datasetKey.value
      if (!own || notice.datasetKey !== own) return
      if (notice.all) {
        const n = dataset.forgetAllPersistedFrames()
        if (n) core.statusText.value = `另一标签页回收了本数据集 ${formatBytes(notice.bytes)} 缓存，已改回整体保存`
        return
      }
      if (!notice.frames.length) return
      dataset.forgetPersistedFrames(notice.frames)
      core.statusText.value = `另一标签页回收了本数据集 ${notice.frames.length} 帧缓存（${formatBytes(notice.bytes)}），切帧时会重新解码`
    })
    syncPeerTabs()

    const viewer = new PointCloudViewer(core.viewportRef.value)
    core.setViewer(viewer)
    camera.syncCameraVisual()

    // 3D 视口点击拾取：OrbitControls 拖拽结束也会触发 click，用位移阈值过滤
    const el = viewer.renderLoopElement()
    let downX = 0, downY = 0
    const onDown = (e: MouseEvent) => { downX = e.clientX; downY = e.clientY }
    const onClick = (e: MouseEvent) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return
      annotation.onViewerClick(e)
    }
    el.addEventListener('mousedown', onDown)
    el.addEventListener('click', onClick)

    // 3D 视口的悬停高亮：射线拾取，限频 ~20Hz。
    // 拖拽（OrbitControls 旋转/平移）期间不拾取，否则视角一转光晕就乱跳。
    let lastHoverAt = 0
    const onHoverMove = (e: MouseEvent) => {
      if (e.buttons) return
      const now = performance.now()
      if (now - lastHoverAt < 45) return
      lastHoverAt = now
      core.setHover(viewer.pickBox(e.clientX, e.clientY, core.visibleBoxes.value))
    }
    const onHoverLeave = () => core.setHover(null)
    el.addEventListener('mousemove', onHoverMove)
    el.addEventListener('mouseleave', onHoverLeave)

    viewportCleanup.push(() => {
      el.removeEventListener('mousedown', onDown)
      el.removeEventListener('click', onClick)
      el.removeEventListener('mousemove', onHoverMove)
      el.removeEventListener('mouseleave', onHoverLeave)
    })

    window.addEventListener('keydown', annotation.onKeyDown)
    window.addEventListener('keydown', onResizeShortcut)
    // 复核快捷键要在常规键位之前拿到：捕获阶段注册，面板打开时才消费 A/X/Tab，
    // 关掉面板立刻归还给原快捷键（A 仍然是沿 +y 平移）
    window.addEventListener('keydown', onReviewKey, true)
    window.addEventListener('beforeunload', onBeforeUnload)

    // 排定启动数据集：显式 URL 参数优先，其次本地草稿，最后演示场景
    const params = new URLSearchParams(location.search)
    // `?evict=lfu` 是策略的临时覆盖入口（手测与回归用），不写回存储
    const requestedPolicy = params.get('evict')
    if (isEvictionPolicy(requestedPolicy)) evictionPolicy.value = requestedPolicy
    const demo = params.get('data')
    if (demo === 'real') {
      await dataset.loadRealData()
    } else if (demo === 'sequence') {
      // `?frames=N` 只影响演示序列长度（手测 VLA / 时间线用），不影响真实数据集
      dataset.loadSequence(Number(params.get('frames')) || undefined)
      if (params.get('autoplay') === '1') sequence.play()
    } else if (demo === 'qa') {
      dataset.loadDemo()
      quality.runQualityCheck()
    } else if (demo === 'semantic') {
      dataset.loadSemanticDemo()
    } else {
      let restored = false
      try {
        // doc-first：指针指向的 v2 文档是标注真值，v1 快照提供帧布局与点云。
        // 文档读不到（旧版本存的、被清过、事务失败）才退回纯 v1 恢复。
        const [pointer, snapshot] = await Promise.all([loadDraftPointer(), loadSession()])
        if (pointer?.sampleId) {
          const store = studioStore()
          const doc = store ? await store.documents.load(pointer.sampleId) : null
          if (doc) restored = await dataset.restoreFromDocument(doc, snapshot, pointer.datasetKey)
        }
        if (!restored && snapshot) restored = await dataset.restore(snapshot)
      } catch { /* 草稿坏了就当没有 */ }
      if (!restored) dataset.loadDemo()
    }

    // 首屏尺寸可能在 v-show 切换后变化，补一次
    requestAnimationFrame(() => viewer.resize())

    // 启动清扫：只有等装载/恢复都完成，才知道"当前数据集"和"草稿指向的数据集"。
    // 延迟一拍是为了不和首帧解码抢主线程。
    window.setTimeout(() => { void runBlobGc({ trigger: 'startup' }) }, 1500)

    ;(function animate() {
      requestAnimationFrame(animate)
      viewer.render()
    })()
  })

  // 主视口 / 正交条显隐后必须重算 WebGL 画布尺寸
  watch([core.orthoMax, core.showOrtho, core.layout], () => {
    nextTick(() => core.getViewer()?.resize())
  })

  onBeforeUnmount(() => {
    sequence.pausePlay()
    camera.cleanup()
    reclaimer.dispose()
    offFramesEvicted?.()
    // 主动释放租约：否则另一个标签页要等 TTL 过期才能接管
    bus.stop()
    // 使用时间最后一次落库。不写的话，最近 800ms 内看过的帧在库里仍记着旧时间，
    // 下次启动清扫会把刚看过的帧当成"最久未用" —— 淘汰顺序错位就是这么来的
    void flushFrameUse()
    if (saveTimer) window.clearTimeout(saveTimer)
    if (core.saveState.value === 'dirty') void persistNow()

    const viewer = core.getViewer()
    for (const fn of viewportCleanup) fn()
    window.removeEventListener('keydown', annotation.onKeyDown)
    window.removeEventListener('keydown', onResizeShortcut)
    window.removeEventListener('keydown', onReviewKey, true)
    window.removeEventListener('beforeunload', onBeforeUnload)
    viewer?.dispose()
  })

  return {
    ...core,
    ...annotation,
    ...dataset,
    ...sequence,
    ...quality,
    ...camera,
    ...library,
    ...preAnnotation,
    ...tasks,
    ...vla,
    showHelp,
    menuOpen,
    persistNow,
    clearDraft,
    runBlobGc,
    evictionPolicy,
    setEvictionPolicy,
    takeoverScene,
    gcAudit,
    clearGcAuditLog,
    peerTabs,
    syncPeerTabs,
    tabBus: bus,
    issueTypeName,
    numVal,
    strVal,
  }
}
