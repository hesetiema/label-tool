/**
 * ============================================================
 * IndexedDB 引导层 —— 全项目唯一的建库入口
 * ============================================================
 *
 * 【为什么单独抽一个文件】
 *   `session.ts`（v1 草稿）与 `adapters/indexedDbStore.ts`（v2 文档）
 *   必须用同一个版本号打开同一个库。两个文件各写一份 `indexedDB.open(name, ver)`，
 *   一旦版本号不一致，后打开的那个会抛 `VersionError`，表现为"某天突然存不了草稿"。
 *
 * 【v1 → v2 升级做了什么】
 *   v1 只有 `session` 一个 store（当前草稿，单 key）。
 *   v2 增加三个：
 *     documents —— 文档元信息（每个 sample 一条）
 *     docTasks  —— 任务分段（sample + task 一条，避免改一个框重写整文档）
 *     blobs     —— 二进制载荷（点云帧、语义标签、占据 RLE）
 *   旧的 `session` 保留不删：v1 草稿仍能被读出来迁移，用户不会"升级后数据消失"。
 *
 * 【v2 → v3 升级做了什么】
 *   只加了一个 `blobUsage`：`键 → 最后读取时间`，几十字节一条。
 *
 *   为什么必须单独一个 store：LRU 淘汰需要"这一帧上次被读是什么时候"，
 *   而这个字段每读一次就要刷新。IndexedDB 没有原地更新 —— 改 `blobs` 里
 *   一条记录必须先把整条读出来（1.8MB 的 ArrayBuffer）再写回去。
 *   回放时每秒切一帧，这么写等于把主线程钉在序列化上。
 *   单独存一份元数据，刷新一次只写几十字节。
 *
 *   老记录没有这一条时，读端退回 `savedAt`（见 indexedDbStore 的 list）。
 *
 * 【诚实边界】
 *   这里只做建库与事务封装，不做 schema 迁移的数据搬运。
 *   v1 → v2 的数据迁移在 `adapters/indexedDbStore.ts` 的 `migrateLegacySnapshot` 里，
 *   因为它需要 domain 的类型，而 core 不允许依赖 domain。
 */

export const DB_NAME = 'point-cloud-label-studio'
export const DB_VERSION = 3

export const STORE_SESSION = 'session'
export const STORE_DOCS = 'documents'
export const STORE_TASKS = 'docTasks'
export const STORE_BLOBS = 'blobs'
/** 帧缓存的使用时间（LRU 判据）。与 blobs 分开，避免刷新时间戳时重写整块二进制 */
export const STORE_USAGE = 'blobUsage'

export function openStudioDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // 逐个补建：从 v0（新用户）和从 v1（老用户）都要能升上来
      for (const name of [STORE_SESSION, STORE_DOCS, STORE_TASKS, STORE_BLOBS, STORE_USAGE]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
    req.onblocked = () => reject(new Error('IndexedDB 升级被其他标签页阻塞，请关闭其他窗口后重试'))
  })
}

export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'))
  })
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中断'))
  })
}
