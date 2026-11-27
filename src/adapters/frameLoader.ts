/**
 * ============================================================
 * 适配器：帧加载器（SampleHandle + FrameCache）
 * ============================================================
 *
 * 【它存在的理由】
 *   `DataSource` 只回答"怎么读一帧"，`FrameCache` 只回答"解码好的放哪儿"。
 *   中间的调度——同一帧不重复解码、切回来还在、预取下一帧、超预算淘汰——
 *   需要一个地方收口，否则这些判断会散落在 `useSequence.gotoFrame` 里。
 *
 * 【为什么 in-flight 要按帧去重】
 *   回放时每 600ms 切一帧，而解析要 200ms；如果用户来回点同一帧两次，
 *   两次都会 miss 缓存、都会读盘解析，结果互相覆盖。
 *   用 `pending` 表把并发请求折叠成同一个 Promise，代价是几行代码，
 *   收益是"真实数据下不会因为连点而雪崩"。
 *
 * 【为什么淘汰时不做任何回调清理】
 *   点云在 GPU 上的副本由 viewer 自己管（`setPointCloud` 用引用比较），
 *   CPU 侧被淘汰后下次会重新解码；不在这里释放 GPU，因为可能过 200ms 又切回来。
 */
import { FrameCache, type FrameCacheStats } from '../domain/store/frameCache'
import type { ParsePriority, SampleHandle } from '../ports/dataSource'
import type { PointCloud } from '../core/types'

export interface FrameLoaderOptions {
  /** 字节预算，默认沿用 FrameCache 的 256MB */
  budgetBytes?: number
  /** 每帧解码完成时回调：用于落盘缓存 / 更新状态栏 */
  onLoad?: (frame: number, cloud: PointCloud) => void
}

export interface FrameLoaderStats extends FrameCacheStats {
  inflight: number
  cachedBytes: number
  budgetBytes: number
}

export interface FrameLoader {
  get(frame: number): Promise<PointCloud>
  /** 预取前后若干帧；失败静默（预取失败不该弹错误） */
  prefetch(frame: number, radius?: number): void
  cached(frame: number): PointCloud | undefined
  stats(): FrameLoaderStats
  dispose(): void
}

export function createFrameLoader(handle: SampleHandle, opts: FrameLoaderOptions = {}): FrameLoader {
  const cache = new FrameCache<PointCloud>({ budgetBytes: opts.budgetBytes })
  const pending = new Map<number, Promise<PointCloud>>()
  let disposed = false

  function keyOf(frame: number): string {
    return String(frame)
  }

  function get(frame: number): Promise<PointCloud> {
    return load(frame, 'high')
  }

  /**
   * 统一的解码入口，带优先级。
   *
   * `get` 走 high、`prefetch` 走 low —— 这样用户点第 30 帧时，
   * 队列里排着的预取帧会给它让路。已经在解码的帧不会被打断（见 pcdParser 文件头）。
   */
  function load(frame: number, priority: ParsePriority): Promise<PointCloud> {
    if (disposed) return Promise.reject(new Error('帧加载器已释放'))
    const hit = cache.get(keyOf(frame))
    if (hit) return Promise.resolve(hit)

    const running = pending.get(frame)
    // 同一帧不重复解码：已有一个在跑就复用它，哪怕这次是更高优先级。
    // 重复解码要多花 200ms，而等它跑完最多也就 200ms。
    if (running) return running

    const job = handle
      .frame(frame, { priority })
      .then((payload) => {
        pending.delete(frame)
        // 解码期间可能已被 dispose：仍然把结果给调用方，但不写缓存
        if (!disposed) cache.set(keyOf(frame), payload.cloud)
        opts.onLoad?.(frame, payload.cloud)
        return payload.cloud
      })
      .catch((err) => {
        pending.delete(frame)
        throw err instanceof Error ? err : new Error(String(err))
      })

    pending.set(frame, job)
    return job
  }

  function prefetch(frame: number, radius = 1): void {
    for (let d = 1; d <= radius; d++) {
      for (const f of [frame + d, frame - d]) {
        if (f < 0 || cache.has(keyOf(f)) || pending.has(f)) continue
        // 预取是纯预热：失败静默，且必须让位于用户正在等的帧
        void load(f, 'low').catch(() => {
          /* 预取失败不影响当前帧 */
        })
      }
    }
  }

  function stats(): FrameLoaderStats {
    return {
      ...cache.stats,
      inflight: pending.size,
      cachedBytes: cache.byteSize,
      budgetBytes: cache.budgetBytes,
    }
  }

  function dispose(): void {
    disposed = true
    pending.clear()
    cache.clear()
  }

  return {
    get,
    prefetch,
    cached: (frame) => cache.peek(keyOf(frame)),
    stats,
    dispose,
  }
}
