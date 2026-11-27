/**
 * ============================================================
 * FrameCache —— 按字节预算的 LRU 帧窗口
 * ============================================================
 *
 * 【为什么按字节而不是按条数】
 *   一帧可能是 2 万点（240KB），也可能是 150 万点（18MB）——差 75 倍。
 *   "缓存 20 帧"在小数据上浪费内存，在大数据上直接 OOM。
 *   按字节预算（默认 256MB）才能让同一份代码同时跑演示和真实数据。
 *
 * 【为什么命中必须返回同一个引用】
 *   `PointCloudViewer.setPointCloud` 用引用比较判断"要不要重传 GPU 几何"
 *   （viewer/PointCloudViewer.ts 的 lastCloudRef 思路）。
 *   缓存若每次克隆，切帧会变成每秒几十 MB 的 GPU 上传。
 *
 * 【诚实边界】
 *   这是主线程缓存，不做预取调度。真正的后台解析在 workers/parse.worker.ts（P0 后续），
 *   本类只负责"已经解码好的帧放哪儿、什么时候扔"。
 */

export interface FrameCacheOptions<T> {
  /** 字节预算，默认 256MB */
  budgetBytes?: number
  /** 单个值的字节数估算；缺省按 PointCloud.positions.byteLength 估 */
  weigh?: (value: T) => number
  /** 淘汰回调：用于释放 GPU 侧资源或统计 */
  onEvict?: (key: string, value: T) => void
}

export interface FrameCacheStats {
  hits: number
  misses: number
  evictions: number
  /** 因单帧超过预算而拒绝缓存 */
  rejected: number
}

interface Entry<T> {
  value: T
  bytes: number
}

const DEFAULT_BUDGET = 256 * 1024 * 1024

function defaultWeigh(value: unknown): number {
  if (value && typeof value === 'object' && 'positions' in value) {
    const positions = (value as { positions?: ArrayBufferView }).positions
    if (positions) return positions.byteLength
  }
  return 1024
}

export class FrameCache<T> {
  private map = new Map<string, Entry<T>>()
  private bytes = 0
  private readonly budget: number
  private readonly weigh: (value: T) => number
  private readonly onEvict?: (key: string, value: T) => void
  private counters: FrameCacheStats = { hits: 0, misses: 0, evictions: 0, rejected: 0 }

  constructor(options: FrameCacheOptions<T> = {}) {
    this.budget = Math.max(0, options.budgetBytes ?? DEFAULT_BUDGET)
    this.weigh = options.weigh ?? ((v) => defaultWeigh(v))
    this.onEvict = options.onEvict
  }

  /** 读取并刷新 LRU 顺序（Map 的插入顺序即 LRU 顺序） */
  get(key: string): T | undefined {
    const entry = this.map.get(key)
    if (!entry) {
      this.counters.misses++
      return undefined
    }
    this.map.delete(key)
    this.map.set(key, entry)
    this.counters.hits++
    return entry.value
  }

  /** 只看不刷新顺序，用于统计/调试 */
  peek(key: string): T | undefined {
    return this.map.get(key)?.value
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  set(key: string, value: T): void {
    const bytes = Math.max(0, this.weigh(value))
    if (bytes > this.budget) {
      // 单帧就超预算：不缓存，避免"刚放进来就把别的全挤掉"
      this.counters.rejected++
      return
    }
    const existing = this.map.get(key)
    if (existing) {
      this.bytes -= existing.bytes
      this.map.delete(key)
    }
    this.map.set(key, { value, bytes })
    this.bytes += bytes
    this.evictUntilFits()
  }

  delete(key: string): boolean {
    const entry = this.map.get(key)
    if (!entry) return false
    this.map.delete(key)
    this.bytes -= entry.bytes
    return true
  }

  clear(): void {
    if (this.onEvict) for (const [key, entry] of this.map) this.onEvict(key, entry.value)
    this.map.clear()
    this.bytes = 0
  }

  keys(): string[] {
    return [...this.map.keys()]
  }

  get size(): number {
    return this.map.size
  }
  get byteSize(): number {
    return this.bytes
  }
  get budgetBytes(): number {
    return this.budget
  }
  get stats(): FrameCacheStats {
    return { ...this.counters }
  }

  private evictUntilFits(): void {
    while (this.bytes > this.budget && this.map.size) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      const key = oldest.value
      const entry = this.map.get(key)!
      this.map.delete(key)
      this.bytes -= entry.bytes
      this.counters.evictions++
      this.onEvict?.(key, entry.value)
    }
  }
}
