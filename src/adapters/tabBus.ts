/**
 * ============================================================
 * 适配器：跨标签页总线（presence / 租约 / 引用广播）
 * ============================================================
 *
 * 三样东西，共用一条 BroadcastChannel + 一份 localStorage：
 *
 *   presence   每个标签页 2s 写一条 `lt:tab:<id>`（样本 / 数据集 / 时间戳）。
 *              只用于状态栏排障与"这个样本还有谁开着"。
 *   lease      同一样本的写权：`lt:lease:<sampleId>` = { tabId, at }。
 *              **本地存储而不是 BroadcastChannel**：它需要跨"标签页崩溃"存活，
 *              而 BroadcastChannel 只传递活着的进程之间的事件。过期由 TTL 兜底。
 *   refs       清扫前的引用汇总。这个必须**实时问**：对端的引用集每秒都在变，
 *              落在存储里的一定是旧值。所以走广播 request/response。
 *   evicted    配额淘汰删掉帧之后的通知。**必须有** —— 被删的帧是另一个标签页
 *              正在用的，它的 `persistedFrames` 记账是内存里的，
 *              不通知就会写出"只留封面帧"的 spill 快照，刷新后点云全空。
 *
 * 【为什么 claim 要"写完再读一遍"】
 *   两个标签页同时打开同一样本时，两个 claim 可能先后写入 localStorage：
 *   A 写 → B 写 → A 读到自己被覆盖。所以写完之后等一个回合再读，
 *   谁最后被读到谁是赢家。这不是强一致（localStorage 没有 CAS），
 *   但足以把"两边都以为自己在写"的概率压到"同一毫秒内两次打开"。
 *   真要做到强一致得用 Web Locks + IndexedDB 事务，代价是每次保存都多一次锁往返；
 *   而写冲突的后果是"偶发丢一次自动保存"，不是"数据损坏"，不值得。
 *
 * 【降级】
 *   隐私模式/Node 里没有 localStorage：租约判定返回 `supported: false`，
 *   行为退回改造前（谁都能写）；引用汇总返回空集合（清扫只看本端 + 落盘文档）。
 *   宁可少一层保护，也不能因为环境缺 API 让工作台打不开。
 */

import {
  LEASE_TTL_MS,
  judgeLease,
  mergePeerProtection,
  type LeaseRecord,
  type PeerProtection,
  type PeerState,
} from '../domain/store/tabLease'

/** localStorage 的最小面（测试里用假实现，避免依赖真实浏览器存储） */
export interface StorageLike {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface TabState {
  sampleId: string
  datasetKey: string
  payloadRefs: string[]
  /** 当前数据集能否被别的标签页淘汰（`SampleHandle.reloadable`） */
  evictable?: boolean
  /** 当前帧邻域，供别的标签页在淘汰本端数据集时避开 */
  protectKeys?: string[]
}

export interface PeerInfo {
  tabId: string
  sampleId: string
  datasetKey: string
  at: number
  /** 对端自报可重解码（presence 里带的，仅供排障；淘汰判据走 refs 应答） */
  evictable: boolean
}

export interface ClaimResult {
  /** 是否拿到写权 */
  ok: boolean
  /** 当前持有者（自己或别人）；没有租约时为空串 */
  holder: string
  /** 环境是否支持租约（没有 localStorage 时为 false，调用方应放行写入） */
  supported: boolean
}

export interface PeerRefsResult extends PeerProtection {
  /** 响应的对端 id，排障用 */
  peers: string[]
  /** 广播通道是否可用 */
  supported: boolean
}

/**
 * "你的帧被我淘汰了"的通知。
 *
 * 语义是**通知**不是请求：收到的一方只做记账撤回，不阻止、不重试 ——
 * 帧已经删了，阻止没有意义。
 */
export interface FrameEvictionNotice {
  datasetKey: string
  /** 逐帧明细；`all` 为 true 时为空（整份数据集都不可信了） */
  frames: Array<{ frame: number; bytes: number }>
  bytes: number
  all: boolean
}

type BusMessage =
  | { kind: 'refs:req'; from: string; reqId: string }
  | { kind: 'refs:res'; from: string; to: string; reqId: string; state: TabState }
  | { kind: 'lease:lost'; from: string; to: string; sampleId: string }
  | {
    kind: 'frames:evicted'
    from: string
    datasetKey: string
    /** 被淘汰的帧与各自字节；`all` 为 true 时省略（整份数据集都不可信了） */
    frames?: Array<{ frame: number; bytes: number }>
    bytes: number
    /** 淘汰量太大（或整段删）时只发一个标记，省得广播消息几 MB */
    all?: boolean
  }

/** 单条淘汰通知里最多带多少帧；超过就退化成 `all` */
const EVICTED_FRAME_LIMIT = 200

export interface TabBusOptions {
  channelName?: string
  /** 默认取全局 localStorage；显式传 null 表示"没有存储" */
  storage?: StorageLike | null
  /** 标签页 id；测试里固定，便于断言 */
  id?: string
  now?: () => number
  ttlMs?: number
  heartbeatMs?: number
  /** claim 写后校验的等待时间（毫秒） */
  claimWaitMs?: number
}

const TAB_PREFIX = 'lt:tab:'
const LEASE_PREFIX = 'lt:lease:'
const CHANNEL_NAME = 'label-tool/tabs'
/** 标签页身份存在 sessionStorage：刷新后还是"同一个我"，否则会被自己的旧租约锁在门外 */
const SESSION_ID_KEY = 'lt:tab-id'

function randomId(): string {
  // 不需要密码学强度：只要同源的几个标签页里唯一
  return Math.random().toString(36).slice(2, 8)
}

/**
 * 读本标签页的身份。
 *
 * 【为什么不用 localStorage】两个标签页会读到同一个 id，直接失去区分能力。
 * 【为什么刷新后必须还是自己】旧租约还在 localStorage 里、心跳已停，
 *   若每次加载都换 id，刷新后会被"6 秒前还活着的自己"判成只读 ——
 *   用户看到的现象是"按 F5 之后工具不能编辑了"，这是不可接受的。
 */
function readSessionTabId(): string | null {
  try {
    return (globalThis as { sessionStorage?: StorageLike }).sessionStorage?.getItem(SESSION_ID_KEY) ?? null
  } catch {
    return null
  }
}

function persistSessionTabId(id: string): void {
  try {
    ;(globalThis as { sessionStorage?: StorageLike }).sessionStorage?.setItem(SESSION_ID_KEY, id)
  } catch { /* 隐私模式：接受刷新后换 id（最多等一个 TTL） */ }
}

export function resolveLocalStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage
    if (!ls) return null
    // 隐私模式下 getItem 可能直接抛，试探一次
    ls.getItem(TAB_PREFIX + 'probe')
    return ls
  } catch {
    return null
  }
}

export class TabBus {
  readonly tabId: string
  private readonly storage: StorageLike | null
  private readonly channel: BroadcastChannel | null
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly heartbeatMs: number
  private readonly claimWaitMs: number

  private getState: (() => TabState) | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  /** 当前持有租约的样本；空串表示没持有 */
  private sampleId = ''
  private refsWaiters = new Map<string, (state: PeerState) => void>()
  private leaseLostHandlers: Array<(reason: 'takeover' | 'expired') => void> = []
  /** 帧被别的标签页淘汰时的回调（本端要把落盘记账撤回） */
  private frameEvictedHandlers: Array<(eviction: FrameEvictionNotice) => void> = []
  private seq = 0
  private started = false

  private readonly onStorage = (e: StorageEvent) => {
    if (!this.sampleId || !e.key) return
    if (e.key !== LEASE_PREFIX + this.sampleId) return
    // 只有"别人把租约改成了自己"才需要反应；清空（null）说明对方主动释放
    const rec = this.readLease(this.sampleId)
    if (rec && rec.tabId !== this.tabId) this.emitLeaseLost('takeover')
    else if (!rec) this.emitLeaseLost('expired')
  }

  private readonly onPageHide = () => { this.release() }

  constructor(opts: TabBusOptions = {}) {
    const carried = opts.id ? null : readSessionTabId()
    this.tabId = opts.id ?? carried ?? randomId()
    if (!opts.id && !carried) persistSessionTabId(this.tabId)
    this.storage = opts.storage === undefined ? resolveLocalStorage() : opts.storage
    this.now = opts.now ?? (() => Date.now())
    this.ttlMs = opts.ttlMs ?? LEASE_TTL_MS
    this.heartbeatMs = opts.heartbeatMs ?? 2000
    this.claimWaitMs = opts.claimWaitMs ?? 45

    let channel: BroadcastChannel | null = null
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(opts.channelName ?? CHANNEL_NAME)
      } catch {
        channel = null
      }
    }
    this.channel = channel
    if (channel) channel.onmessage = (ev: MessageEvent) => this.handle(ev.data as BusMessage)
  }

  get supported(): boolean { return this.storage !== null }
  get broadcastSupported(): boolean { return this.channel !== null }

  /**
   * 开始心跳与应答。`getState` 每次被问到时现取 —— 缓存引用集
   * 就是给对端提供过期情报，而清扫会拿它当"不能删"的依据。
   */
  start(getState?: () => TabState): void {
    if (getState) this.getState = getState
    if (this.started) return
    this.started = true
    if (this.storage) {
      this.beat()
      this.heartbeat = setInterval(() => { this.beat() }, this.heartbeatMs)
      if (typeof window !== 'undefined') {
        window.addEventListener('storage', this.onStorage)
        window.addEventListener('pagehide', this.onPageHide)
      }
    }
  }

  stop(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.onStorage)
      window.removeEventListener('pagehide', this.onPageHide)
    }
    this.release()
    this.storage?.removeItem(TAB_PREFIX + this.tabId)
    this.started = false
    try { this.channel?.close() } catch { /* 已关闭 */ }
  }

  onLeaseLost(handler: (reason: 'takeover' | 'expired') => void): () => void {
    this.leaseLostHandlers.push(handler)
    return () => {
      this.leaseLostHandlers = this.leaseLostHandlers.filter((h) => h !== handler)
    }
  }

  /** 订阅"帧被对端淘汰"的通知；返回取消函数 */
  onFramesEvicted(handler: (notice: FrameEvictionNotice) => void): () => void {
    this.frameEvictedHandlers.push(handler)
    return () => {
      this.frameEvictedHandlers = this.frameEvictedHandlers.filter((h) => h !== handler)
    }
  }

  /**
   * 告诉对端"我删了你数据集里的这些帧"。
   *
   * 失败静默：广播不通时对方最多写出一份乐观的 spill 快照，
   * 与"因为通知失败就不淘汰"相比，后者会让配额一直降不下来。
   */
  announceFramesEvicted(datasetKey: string, frames: Array<{ frame: number; bytes: number }>, bytes: number): void {
    if (!this.channel || !datasetKey) return
    const tooMany = frames.length > EVICTED_FRAME_LIMIT
    try {
      this.channel.postMessage({
        kind: 'frames:evicted',
        from: this.tabId,
        datasetKey,
        ...(tooMany ? { all: true } : { frames }),
        bytes,
      } satisfies BusMessage)
    } catch { /* 通道已关：对方靠自己的下一次清扫兜底 */ }
  }

  /** 同源的其它标签页（已过滤过期） */
  peers(): PeerInfo[] {
    const out: PeerInfo[] = []
    const ls = this.storage
    if (!ls) return out
    const now = this.now()
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i)
      if (!key || !key.startsWith(TAB_PREFIX)) continue
      const id = key.slice(TAB_PREFIX.length)
      if (id === this.tabId) continue
      const raw = ls.getItem(key)
      if (!raw) continue
      let rec: { at?: number; sampleId?: string; datasetKey?: string; evictable?: boolean }
      try { rec = JSON.parse(raw) } catch { continue }
      if (!Number.isFinite(rec.at) || now - (rec.at as number) > this.ttlMs) continue
      out.push({
        tabId: id,
        sampleId: rec.sampleId ?? '',
        datasetKey: rec.datasetKey ?? '',
        at: rec.at as number,
        evictable: rec.evictable === true,
      })
    }
    return out
  }

  /**
   * 申请某个样本的写权。
   *
   * 返回 `ok: false` 时调用方应转只读，并把 `holder` 展示给用户 ——
   * "另一个标签页（a1b2c3）正在编辑"比"保存被跳过"有用得多。
   */
  async claim(sampleId: string): Promise<ClaimResult> {
    if (!sampleId) return { ok: true, holder: this.tabId, supported: this.supported }
    const ls = this.storage
    if (!ls) return { ok: true, holder: this.tabId, supported: false }

    // 换样本了：先把上一个租约还回去，否则它要挂到 TTL 过期，
    // 期间别的标签页打开那个样本会被无谓地判成只读
    if (this.sampleId && this.sampleId !== sampleId) this.release()

    // 已经持有同一个样本：只续期，不做写后校验（避免每次保存都等 45ms）
    const cur = this.readLease(sampleId)
    const verdict = judgeLease(cur, this.tabId, this.now(), this.ttlMs)
    if (verdict.state === 'mine') {
      this.writeLease(sampleId)
      this.sampleId = sampleId
      return { ok: true, holder: this.tabId, supported: true }
    }
    if (verdict.state === 'held') {
      return { ok: false, holder: verdict.tabId, supported: true }
    }

    this.writeLease(sampleId)
    this.sampleId = sampleId
    if (this.claimWaitMs <= 0) return { ok: true, holder: this.tabId, supported: true }

    await new Promise<void>((resolve) => setTimeout(resolve, this.claimWaitMs))
    const settled = this.readLease(sampleId)
    if (settled && settled.tabId !== this.tabId) {
      // 被抢了：把本地记录清掉，否则心跳会继续替别人"续期"
      this.sampleId = ''
      return { ok: false, holder: settled.tabId, supported: true }
    }
    return { ok: true, holder: this.tabId, supported: true }
  }

  /**
   * 强行接管：不等待、不校验，直接把租约改成自己，并通知原持有者转只读。
   * 这是用户在状态栏点"接管"时的显式动作 —— 他知道另一个标签页在编辑。
   */
  takeover(sampleId: string): ClaimResult {
    if (!sampleId || !this.storage) {
      this.sampleId = sampleId
      return { ok: true, holder: this.tabId, supported: this.supported }
    }
    const prior = this.readLease(sampleId)
    this.writeLease(sampleId)
    this.sampleId = sampleId
    if (prior && prior.tabId !== this.tabId && this.channel) {
      try {
        this.channel.postMessage({
          kind: 'lease:lost', from: this.tabId, to: prior.tabId, sampleId,
        } satisfies BusMessage)
      } catch { /* 通道关了就算了，对方靠心跳看门狗也会发现 */ }
    }
    return { ok: true, holder: this.tabId, supported: true }
  }

  /** 释放租约（只在自己持有时清；不碰别人的记录） */
  release(): void {
    if (!this.storage || !this.sampleId) {
      this.sampleId = ''
      return
    }
    const rec = this.readLease(this.sampleId)
    if (rec && rec.tabId === this.tabId) this.storage.removeItem(LEASE_PREFIX + this.sampleId)
    this.sampleId = ''
  }

  /**
   * 清扫前汇总对端引用。
   *
   * 固定等 `timeoutMs` 而不是"等所有已知标签页回完"：对端可能正忙
   * （解析点云、渲染），等太久会拖慢保存路径上的清扫；而少等一个对端
   * 的代价是"少保护一条引用" —— 所以默认给 320ms，且**已收到的先算数**。
   */
  async collectPeerRefs(timeoutMs = 320): Promise<PeerRefsResult> {
    const empty: PeerRefsResult = {
      payloadRefs: [], datasetKeys: [], sampleIds: [], responders: 0, peers: [], supported: false,
      evictableDatasetKeys: [], protectKeys: [],
    }
    if (!this.channel) return empty

    const reqId = `${this.tabId}:${++this.seq}`
    const received: PeerState[] = []
    this.refsWaiters.set(reqId, (state) => { received.push(state) })
    try {
      this.channel.postMessage({ kind: 'refs:req', from: this.tabId, reqId } satisfies BusMessage)
    } catch {
      this.refsWaiters.delete(reqId)
      return empty
    }

    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    this.refsWaiters.delete(reqId)

    const merged = mergePeerProtection(received)
    return { ...merged, peers: received.map((p) => p.tabId), supported: true }
  }

  /** 供排障：当前租约记录（自己的或别人的） */
  leaseOf(sampleId: string): LeaseRecord | null { return this.readLease(sampleId) }

  /* ---------------- 内部 ---------------- */

  private beat(): void {
    const ls = this.storage
    if (!ls) return
    const state = this.state()
    const at = this.now()
    try {
      ls.setItem(TAB_PREFIX + this.tabId, JSON.stringify({
        at, sampleId: state.sampleId, datasetKey: state.datasetKey, evictable: state.evictable === true,
      }))
      if (this.sampleId) {
        // 续期前先看当前持有点：被别人接管了就不能再写回去（那会来回踢皮球）。
        // 记录不存在说明它过期/被清了 —— 我们仍然认为自己在写，于是重新立起来。
        const rec = this.readLease(this.sampleId)
        if (!rec || rec.tabId === this.tabId) this.writeLease(this.sampleId)
        else {
          this.emitLeaseLost('takeover')
          this.sampleId = ''
        }
      }
    } catch { /* 配额满/隐私模式：心跳失败不影响编辑 */ }
  }

  private state(): TabState {
    try {
      return this.getState?.() ?? { sampleId: '', datasetKey: '', payloadRefs: [] }
    } catch {
      return { sampleId: '', datasetKey: '', payloadRefs: [] }
    }
  }

  private handle(msg: BusMessage): void {
    if (!msg || typeof msg !== 'object') return
    if (msg.kind === 'refs:req') {
      if (msg.from === this.tabId) return
      try {
        this.channel?.postMessage({
          kind: 'refs:res', from: this.tabId, to: msg.from, reqId: msg.reqId, state: this.state(),
        } satisfies BusMessage)
      } catch { /* 通道已关 */ }
      return
    }
    if (msg.kind === 'refs:res') {
      if (msg.to !== this.tabId) return
      this.refsWaiters.get(msg.reqId)?.({ ...msg.state, tabId: msg.from })
      return
    }
    if (msg.kind === 'lease:lost') {
      if (msg.to !== this.tabId) return
      if (msg.sampleId && msg.sampleId !== this.sampleId) return
      this.sampleId = ''
      this.emitLeaseLost('takeover')
      return
    }
    if (msg.kind === 'frames:evicted') {
      // 只有"确实是我现在这份数据集"才需要撤回记账；别人的数据集与本端无关
      if (msg.from === this.tabId) return
      const notice: FrameEvictionNotice = {
        datasetKey: msg.datasetKey,
        frames: Array.isArray(msg.frames) ? msg.frames : [],
        bytes: Number(msg.bytes) || 0,
        all: msg.all === true,
      }
      for (const handler of this.frameEvictedHandlers) {
        try { handler(notice) } catch { /* 一个订阅者出错不该影响其它 */ }
      }
    }
  }

  private emitLeaseLost(reason: 'takeover' | 'expired'): void {
    for (const handler of this.leaseLostHandlers) {
      try { handler(reason) } catch { /* 一个订阅者出错不该影响其它订阅者 */ }
    }
  }

  private readLease(sampleId: string): LeaseRecord | null {
    const raw = this.storage?.getItem(LEASE_PREFIX + sampleId)
    if (!raw) return null
    try {
      const rec = JSON.parse(raw) as LeaseRecord
      if (!rec || typeof rec.tabId !== 'string') return null
      return { tabId: rec.tabId, at: Number(rec.at) }
    } catch {
      return null
    }
  }

  private writeLease(sampleId: string): void {
    try {
      this.storage?.setItem(LEASE_PREFIX + sampleId, JSON.stringify({
        tabId: this.tabId, at: this.now(),
      } satisfies LeaseRecord))
    } catch { /* 写不进去就靠 claim 的返回值兜底 */ }
  }
}

/** 进程内单例：工作台只用一个总线（多个会让 presence 重复上报） */
let singleton: TabBus | null = null

export function tabBus(): TabBus {
  if (!singleton) singleton = new TabBus()
  return singleton
}

/** 测试/重载用 */
export function resetTabBus(): void {
  singleton?.stop()
  singleton = null
}
