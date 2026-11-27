/**
 * ============================================================
 * 工作台级 GC —— 把几处信息凑成一次清扫
 * ============================================================
 *
 * 判定"哪些 blob 还有用"需要这几个来源，缺一个就会误删：
 *
 *   1. **内存引用**：`TrackStore.liveBlobRefs()`（撤销栈 + 重做栈 + 当前文档）
 *   2. **落盘引用**：`DocumentStore.listBlobRefs()`（刷新后内存是空的，
 *      但文档还指着那些 blob —— 启动清扫最容易在这里出事）
 *   3. **草稿指针**：`loadDraftPointer()`（草稿指向哪个数据集的帧缓存）
 *   4. **对端标签页**：另一个标签页内存里的引用与它正开着的数据集。
 *      这一项是 P3 收尾时补的：没有它，两个标签页同时编辑会互删对方的 blob，
 *      而且删的是"对方还没保存进文档的那部分" —— 只有对方知道它存在。
 *
 * 这个文件只做编排，不放判据：判据在 `blobGc.planBlobGc`（纯函数），
 * 这样才能用假 store 在 Node 里把"删对了没有"测清楚。
 */

import { loadDraftPointer } from '../core/io/session'
import { isPayloadRef } from '../domain/store/blobRefs'
import type { BlobStore } from '../ports/blobStore'
import { sweepBlobs, type FrameBudget, type SweepReport } from './blobGc'
import { studioStore } from './studioStore'

export interface StoreGcOptions {
  /** 内存里的存活引用（来自 TrackStore） */
  livePayloadRefs?: Iterable<string>
  /** 正在看的数据集：它的帧缓存不能删 */
  activeDatasetKey?: string
  /** 额外保护的数据集（例如刚导入、草稿还没保存） */
  extraDatasetKeys?: string[]
  /** 对端标签页的存活引用（来自 TabBus.collectPeerRefs） */
  peerPayloadRefs?: Iterable<string>
  /** 对端正开着的帧缓存数据集 */
  peerDatasetKeys?: Iterable<string>
  /** 响应的对端标签页数，只进报告与审计 */
  peers?: number
  /**
   * 配额压力下的帧淘汰。不传就只清死数据集与死载荷。
   *
   * 【为什么由调用方决定目标水位】只有装配层知道"现在用量是多少、涨得多快"；
   * 这里只管照做。`evictableDatasetKeys` 同理 —— 能否重新解码是数据源的能力，
   * 不是存储层能猜的。
   */
  budget?: FrameBudget
  dryRun?: boolean
}

export interface StoreGcResult extends SweepReport {
  liveDatasetKeys: string[]
  livePayloadCount: number
  /**
   * 因为"对端还在用"而免于删除的条数。
   * 这个数字比"回收了多少"更能说明跨标签页协调有没有真的生效：
   * 它是 0 且用户同时开了两个标签页时，就该怀疑广播没通。
   */
  peerProtected: number
  peers: number
}

/** 直接对给定 BlobStore 执行一次清扫（测试/诊断用；不碰单例） */
export async function gcBlobStore(
  blobs: BlobStore,
  opts: Omit<StoreGcOptions, 'activeDatasetKey' | 'extraDatasetKeys' | 'peers'> & {
    liveDatasetKeys?: Iterable<string>
  } = {},
): Promise<StoreGcResult> {
  const ownPayload = new Set<string>(opts.livePayloadRefs ?? [])
  const ownDatasets = [...new Set(opts.liveDatasetKeys ?? [])].filter(Boolean)
  const peerPayload = new Set([...(opts.peerPayloadRefs ?? [])].filter(isPayloadRef))
  const peerDatasets = [...new Set(opts.peerDatasetKeys ?? [])].filter(Boolean)

  const livePayload = new Set([...ownPayload, ...peerPayload])
  const liveDatasets = [...new Set([...ownDatasets, ...peerDatasets])]
  const report = await sweepBlobs({
    blobs,
    livePayloadRefs: livePayload,
    liveDatasetKeys: liveDatasets,
    budget: opts.budget,
    dryRun: opts.dryRun,
  })

  const peerProtected = countPeerProtected(report, ownPayload, new Set(ownDatasets))
  const hasPeerInput = opts.peerPayloadRefs !== undefined || opts.peerDatasetKeys !== undefined
  return {
    ...report,
    liveDatasetKeys: liveDatasets,
    livePayloadCount: livePayload.size,
    peerProtected,
    peers: hasPeerInput ? 1 : 0,
  }
}

/**
 * 数一数有多少条是"本端不认识、靠对端才留下来的"。
 *
 * 判据只看判定结果，不重新扫库：
 *   - 载荷：留下且理由是可回收载荷的活引用，但本端引用集里没有它
 *   - 帧缓存：留下且数据集不在本端的数据集集合里
 */
function countPeerProtected(report: SweepReport, ownPayload: Set<string>, ownDatasets: Set<string>): number {
  let n = 0
  for (const v of report.verdicts) {
    if (!v.keep) continue
    if (v.reason === 'live-payload' && !ownPayload.has(v.key)) n++
    else if (v.reason === 'live-dataset' && v.datasetKey && !ownDatasets.has(v.datasetKey)) n++
    else if (v.reason === 'legacy-live' && !ownDatasets.size) n++
  }
  return n
}

/**
 * 工作台清扫。浏览器里调用；没有 IndexedDB（Node / 隐私模式）返回 null。
 */
export async function runStoreGc(opts: StoreGcOptions = {}): Promise<StoreGcResult | null> {
  const store = studioStore()
  if (!store) return null

  const [pointer, docRefs] = await Promise.all([
    loadDraftPointer().catch(() => null),
    store.documents.listBlobRefs().catch(() => [] as string[]),
  ])

  const ownPayload = new Set(docRefs)
  for (const ref of opts.livePayloadRefs ?? []) ownPayload.add(ref)
  const peerPayload = new Set([...(opts.peerPayloadRefs ?? [])].filter(isPayloadRef))

  const ownDatasets = new Set<string>(opts.extraDatasetKeys ?? [])
  if (opts.activeDatasetKey) ownDatasets.add(opts.activeDatasetKey)
  if (pointer?.datasetKey) ownDatasets.add(pointer.datasetKey)
  const peerDatasets = [...new Set(opts.peerDatasetKeys ?? [])].filter(Boolean)

  const livePayload = new Set([...ownPayload, ...peerPayload])
  const datasets = new Set([...ownDatasets, ...peerDatasets])

  const report = await sweepBlobs({
    blobs: store.blobs,
    livePayloadRefs: livePayload,
    liveDatasetKeys: [...datasets],
    budget: opts.budget,
    dryRun: opts.dryRun,
  })
  return {
    ...report,
    liveDatasetKeys: [...datasets],
    livePayloadCount: livePayload.size,
    peerProtected: countPeerProtected(report, ownPayload, ownDatasets),
    peers: opts.peers ?? 0,
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}
