/**
 * ============================================================
 * 跨标签页协调 —— 纯判定
 * ============================================================
 *
 * 【为什么这件事非做不可】
 *   两个标签页打开同一个样本时，有三处会互相踩，其中两处会**丢数据**：
 *
 *   1. **文档写入**：两边各自持有内存里的 `TrackStore`，自动保存都是
 *      "整段 boxes 覆盖"。后保存的那个会把另一边的框静默抹掉 ——
 *      没有报错、没有提示，只是"我刚标的框不见了"。
 *   2. **blob 清扫**：A 的清扫只看得到 A 自己的引用集 + 落盘文档 + 草稿指针。
 *      B 刚写进 IndexedDB、还没进文档的载荷，在 A 眼里就是垃圾。
 *   3. **帧缓存**：A 判定"数据集没人用了"（草稿指针指向别处），而 B 正开着它。
 *
 *   第 2、3 项靠"清扫前汇总对端引用"解决；第 1 项靠"同一样本只允许一个
 *   标签页写"（租约）解决。本文件只放判据，协议与存储见 `adapters/tabBus.ts`。
 *
 * 【为什么判据要单独抽出来】
 *   租约与引用汇总都跑在浏览器里（localStorage / BroadcastChannel），
 *   在 Node 里测不到。把"该怎么判"写成纯函数，就能把最容易错的边界
 *   （过期、抢占、自己持有、对方持有）在单测里穷举。
 */

import { isPayloadRef } from './blobRefs'

/**
 * 租约有效期。心跳 2s，三拍不上线即视为标签页已关闭。
 *
 * 太短：切到后台的标签页（定时器被节流到 1 次/分钟）会被误判为已退出，
 * 于是两个标签页同时"持有"租约 —— 又回到互相覆盖。
 * 太长：用户关掉标签页后另一个标签页要干等。
 * 6s 是"后台节流仍能续上"与"关掉后能较快接管"的折中。
 */
export const LEASE_TTL_MS = 6000

export interface LeaseRecord {
  tabId: string
  /** 写入/续期时刻（毫秒时间戳） */
  at: number
}

export type LeaseVerdict =
  | { state: 'free' }
  | { state: 'mine' }
  | { state: 'held'; tabId: string; ageMs: number }

/**
 * 一条租约记录现在归谁。
 *
 * - 没有记录 / 记录损坏 / 已过期 → free（可以抢）
 * - 记录是自己的 → mine（正常续期；即使时间戳很旧也算自己的，
 *   因为"我"确实还活着，时间戳旧只说明心跳断过）
 * - 记录是别人的且未过期 → held
 */
export function judgeLease(
  rec: LeaseRecord | null | undefined,
  tabId: string,
  now: number,
  ttlMs: number = LEASE_TTL_MS,
): LeaseVerdict {
  if (!rec || typeof rec.tabId !== 'string' || !rec.tabId) return { state: 'free' }
  if (rec.tabId === tabId) return { state: 'mine' }
  const at = Number(rec.at)
  if (!Number.isFinite(at)) return { state: 'free' }
  const age = now - at
  // 时间戳在未来（改过系统时钟）时不当作过期，宁可多等一拍
  if (age > ttlMs) return { state: 'free' }
  return { state: 'held', tabId: rec.tabId, ageMs: Math.max(0, age) }
}

/** 对端标签页自报的状态（协议里 `refs:res` 的载荷） */
export interface PeerState {
  tabId: string
  sampleId?: string
  datasetKey?: string
  /** 对端内存里仍被引用的载荷键（`payload/<hash>`） */
  payloadRefs?: string[]
  /**
   * 对端当前数据集**能不能被本端淘汰**（`SampleHandle.reloadable`）。
   *
   * 【为什么要问这一句】帧缓存是跨标签页共享的（同一个 origin 的同一个库），
   * 而配额也是共享的。本端可腾的空间往往不够，真正占着几个 GB 的是另一个
   * 标签页。但只有"它能重新解码"时才敢动它的帧 —— 恢复型会话的缓存是唯一副本。
   * 这个标志默认不存在，等价于 false：判不准就不动。
   */
  evictable?: boolean
  /**
   * 对端自己算好的保护键（当前帧前后各两帧）。
   *
   * 【为什么由对端给而不是本端猜】保护范围是 `(datasetKey, 当前帧)` 的函数，
   * 当前帧只有对端知道。让谁的数据集谁提供保护键，协议就不必再传一次帧号。
   */
  protectKeys?: string[]
}

export interface PeerProtection {
  /** 对端引用、本端不知道的载荷（已过滤成合法的 payload 键） */
  payloadRefs: string[]
  /** 对端正开着的帧缓存数据集 */
  datasetKeys: string[]
  /** 对端打开的样本 id（用于判断"同一样本"与排障） */
  sampleIds: string[]
  /** 有多少个对端响应了（0 说明没有别的标签页，或广播不可用） */
  responders: number
  /** 对端声明**可重解码**的数据集：可以进全局淘汰的候选池 */
  evictableDatasetKeys: string[]
  /** 对端请求保护的键；本端淘汰对端数据集时必须避开 */
  protectKeys: string[]
}

/** 单个对端最多接受多少条保护键：15 条是正常值，几百条只可能是协议出错 */
const PEER_PROTECT_LIMIT = 256

/**
 * 把对端自报的状态合并成"清扫时必须保护"的集合。
 *
 * 刻意**不做**"谁的数据集更新就信谁"这类聪明判断：清扫是删除动作，
 * 判不准的时候多留几个 MB 是可恢复的，删掉用户的点云不是。
 * 所以只要对端说"我还在用"，就保护。
 */
export function mergePeerProtection(peers: Iterable<PeerState>): PeerProtection {
  const payloadRefs = new Set<string>()
  const datasetKeys = new Set<string>()
  const sampleIds = new Set<string>()
  const evictable = new Set<string>()
  const protect = new Set<string>()
  let responders = 0

  for (const peer of peers) {
    responders++
    for (const ref of peer.payloadRefs ?? []) {
      if (isPayloadRef(ref)) payloadRefs.add(ref)
    }
    if (peer.datasetKey) datasetKeys.add(peer.datasetKey)
    // 没有 datasetKey 的 evictable 毫无意义（不知道能删哪个数据集）
    if (peer.datasetKey && peer.evictable) evictable.add(peer.datasetKey)
    if (peer.sampleId) sampleIds.add(peer.sampleId)
    for (const key of peer.protectKeys ?? []) {
      if (protect.size >= PEER_PROTECT_LIMIT) break
      if (typeof key === 'string' && key) protect.add(key)
    }
  }

  return {
    payloadRefs: [...payloadRefs],
    datasetKeys: [...datasetKeys],
    sampleIds: [...sampleIds],
    responders,
    evictableDatasetKeys: [...evictable],
    protectKeys: [...protect],
  }
}

/**
 * 固定长度的环形缓冲：超限时丢最旧的。
 * 回收审计、对端名单都用它 —— 这两个东西只用于事后追查，
 * 不该无限增长，也不该因为写满就报错。
 */
export function pushCapped<T>(list: T[], item: T, cap: number): T[] {
  const next = [item, ...list]
  return next.length > cap ? next.slice(0, cap) : next
}
