/**
 * ============================================================
 * 适配器：IndexedDB 存储单例
 * ============================================================
 * 三个模块（数据装载、自动保存、草稿恢复）都要碰同一个库。
 * 各自 `createIndexedDbStore()` 会打开三条连接，浏览器对同源连接数有上限，
 * 而且升级时容易互相阻塞（`onblocked`）。这里收成一个缓存实例。
 *
 * 为什么不在模块顶层直接创建：
 *   Node 里跑测试时没有 `indexedDB`，顶层创建会直接抛错，把整个测试文件带崩。
 *   所以延迟到第一次调用，并且显式检查环境。
 */
import { createIndexedDbStore, type StudioStore } from './indexedDbStore'

let cached: StudioStore | null = null

export function studioStore(): StudioStore | null {
  if (typeof indexedDB === 'undefined') return null
  if (!cached) {
    try {
      cached = createIndexedDbStore()
    } catch {
      return null
    }
  }
  return cached
}

/** 测试 / 热重载用：关掉连接并丢掉缓存 */
export function resetStudioStore(): void {
  cached?.close()
  cached = null
}
