/**
 * ============================================================
 * 适配器：IndexedDB 文档存储（schema v2）
 * ============================================================
 *
 * 【物理分段，逻辑一个文档】
 *   旧实现把"全量点云 + 全量框 + 类别"塞进一个 key（`session`/`current`）。
 *   改一个框 = 重写几十 MB，IndexedDB 事务直接卡住主线程。
 *   v2 拆成四类记录：
 *     documents  每个样本一条头（schema / range / meta / 任务清单）
 *     docTasks   `sampleId::task` 一条（只写脏任务 → 改框只写几 KB）
 *     blobs      `frames/<ds>/<frame>` 一条点云 / `payload/<hash>` 一条大载荷
 *     blobUsage  每个 blob 键一条 `{ at, hits }`（淘汰判据，见下）
 *     session    旧的 v1 草稿，只读兼容
 *
 * 【为什么 blobUsage 要单独一个 store】
 *   IndexedDB 没有原地更新：改 `blobs` 里一条记录得把整条读出来（1.8MB 的
 *   ArrayBuffer）再写回。回放时每秒切一帧，那等于把主线程钉在序列化上。
 *   元数据分开存，一次刷新只写几十字节。
 *   记录形状从 `{at}` 扩成 `{at, hits}`（第九批加命中次数）**不需要升版本**：
 *   对象仓库没变，只是记录多了一个可选字段，老记录读到 `hits === undefined`
 *   时按 0 处理即可。
 *
 * 【键规范在 blobKeys.ts】
 *   这里只负责把键原样存进 IndexedDB，不解释键的含义。
 *   "这段字节属于哪个数据集"由 `adapters/blobKeys.ts` 统一判定 ——
 *   GC 依赖这个判定，判定逻辑散落两处必然对不上。
 *
 * 【为什么点云按 (sample, frame) 而不是内容哈希】
 *   方案 4.3 给的是内容哈希（天然去重）。但 1.8MB 的 buffer 算一次哈希
 *   大约 3–5ms，而帧点云导入后**不会再变**，哈希带来的去重收益接近于零
 *   （同一帧的两次解码结果内容相同，但这种情况只发生在重复导入同一个文件）。
 *   所以先按稳定的 (sampleId, frame) 做键；等 P3 的占据/光流载荷进来
 *   （同一份数据被多个样本引用）再引入内容哈希，那时去重才真的有意义。
 *
 * 【Map 的序列化边界】
 *   `Track.states` 是 Map。IndexedDB 的结构化克隆能存 Map，但 JSON 导出、
 *   Worker 传递、跨端同步都会丢。统一在这里转成 `[frame, state][]`，
 *   与 `domain/model/track.ts` 的 `encodeStates` 是同一套约定。
 */
import type { BlobMeta, BlobStore } from '../ports/blobStore'
import type { DocumentStore, StoredDocumentSummary } from '../ports/documentStore'
import type { SampleDocument, TaskKey } from '../domain/model/document'
import type { ObservationState, Track } from '../domain/model/track'
import { decodeStates, encodeStates } from '../domain/model/track'
import type { SampleId } from '../domain/model/ids'
import { collectRefsDeep } from '../domain/store/blobRefs'
import {
  DB_NAME, STORE_BLOBS, STORE_DOCS, STORE_SESSION, STORE_TASKS, STORE_USAGE,
  idbRequest, openStudioDb, txDone,
} from '../core/io/idb'
import type { SessionSnapshot } from '../core/io/session'
import { buildDocumentFromFrames } from '../domain/io/legacyDocument'

/** 落盘形态：states 从 Map 变成数组 */
type StoredTrack = Omit<Track, 'states'> & { states: Array<[number, ObservationState]> }

interface StoredTaskBoxes {
  tracks: StoredTrack[]
  [extra: string]: unknown
}

export interface StoredDocHead {
  sampleId: SampleId
  sceneId: string
  range: [number, number]
  meta: SampleDocument['meta']
  /** 哪些任务段真实存在，load 时按它逐个取 */
  tasks: TaskKey[]
  savedAt: number
}

const ALL_TASKS: TaskKey[] = ['boxes', 'semantic', 'occupancy', 'flow', 'lane', 'vla']

export function taskKey(sampleId: SampleId, task: TaskKey): string {
  return `${sampleId}::${task}`
}

/* ------------------------------------------------------------------
 * 纯函数：编码 / 解码
 * 抽出来是为了能在 Node 里单测 —— IndexedDB 本身没有可用的内存实现，
 * 但"存进去的字节取出来还是不是同一份数据"才是真正会出错的地方。
 * ------------------------------------------------------------------ */

export function encodeTrack(track: Track): StoredTrack {
  return { ...track, states: encodeStates(track) }
}

export function decodeTrack(stored: StoredTrack): Track {
  return { ...stored, states: decodeStates(stored.states) }
}

export function encodeTask(task: TaskKey, payload: unknown): unknown {
  if (task !== 'boxes') return payload
  const boxes = payload as { tracks?: Track[] }
  const out: StoredTaskBoxes = {
    ...(payload as Record<string, unknown>),
    tracks: (boxes.tracks ?? []).map(encodeTrack),
  }
  return out
}

export function decodeTask(task: TaskKey, payload: unknown): unknown {
  if (task !== 'boxes') return payload
  const boxes = payload as StoredTaskBoxes
  return { ...boxes, tracks: (boxes.tracks ?? []).map(decodeTrack) }
}

export function encodeDocument(doc: SampleDocument): {
  head: StoredDocHead
  tasks: Array<{ task: TaskKey; payload: unknown }>
} {
  const present: Array<{ task: TaskKey; payload: unknown }> = []
  for (const task of ALL_TASKS) {
    const payload = doc.tasks[task]
    if (payload === undefined) continue
    present.push({ task, payload: encodeTask(task, payload) })
  }
  return {
    head: {
      sampleId: doc.sampleId,
      sceneId: doc.sceneId,
      range: [doc.range[0], doc.range[1]],
      meta: doc.meta,
      tasks: present.map((p) => p.task),
      savedAt: Date.now(),
    },
    tasks: present,
  }
}

export function decodeDocument(
  head: StoredDocHead,
  tasks: Partial<Record<TaskKey, unknown>>,
): SampleDocument {
  const boxes = decodeTask('boxes', tasks.boxes ?? { tracks: [] }) as SampleDocument['tasks']['boxes']
  const doc: SampleDocument = {
    schema: 2,
    sampleId: head.sampleId,
    sceneId: head.sceneId,
    range: [head.range[0], head.range[1]],
    tasks: { boxes },
    meta: head.meta,
  }
  for (const task of ALL_TASKS) {
    if (task === 'boxes') continue
    const payload = tasks[task]
    if (payload === undefined) continue
    // 任务键与载荷类型一一对应，但联合类型无法让 TS 自己收敛
    ;(doc.tasks as Record<string, unknown>)[task] = decodeTask(task, payload)
  }
  return doc
}

/**
 * 文档头合并 —— `save()` 的语义基石。
 *
 * 【为什么不能整份覆盖 head.tasks】
 *   工作台每次自动保存只构造 boxes 段（几十~几百 KB），占据、光流、语义段
 *   都还好好躺在 `docTasks` 里。若 head 按"这次写了哪些段"重写，
 *   那些段虽然字节还在，却因为 head 不再列它而**永远读不出来** ——
 *   用户看到的现象是"改了一下框，占据任务就没了"。
 *
 * 【为什么只并 tasks】
 *   meta / range / sceneId 是文档级属性，当然以最新文档为准；
 *   `tasks` 描述的是"库里有哪些段"，不是"这次写了哪些段"，所以取并集。
 *   删除任务段必须显式调 `removeTask` —— 合并语义下 save 无法表达"少一个段"。
 *
 * 【为什么保留未知 key】
 *   老客户端读到新版本写的 `vla-2` 段时，不该在下次保存时把它从 head 里抹掉。
 *   宁可让新段"暂时读不出来"，也不能替用户丢数据。
 */
export function mergeDocHead(existing: StoredDocHead | undefined, next: StoredDocHead): StoredDocHead {
  if (!existing) return next
  const union = new Set([...existing.tasks, ...next.tasks])
  // 顺序固定成 ALL_TASKS，避免并集顺序随写入历史漂移（快照测试依赖它）
  const ordered = ALL_TASKS.filter((t) => union.has(t))
  const unknown = [...union].filter((t) => !ALL_TASKS.includes(t))
  return { ...next, tasks: [...ordered, ...unknown] }
}

/** v1 草稿 → v2 文档。迁移逻辑只在 domain，adapter 只负责搭桥 */
export function migrateLegacySnapshot(snapshot: SessionSnapshot): SampleDocument {
  const frames = snapshot.frames.length
    ? snapshot.frames.map((f) => ({ index: f.index, boxes: f.boxes }))
    : [{ index: 0, boxes: snapshot.boxes }]
  return buildDocumentFromFrames(frames, {
    sceneId: 'legacy-draft',
    updatedBy: 'migration',
    updatedAt: snapshot.savedAt,
  })
}

/* ------------------------------------------------------------------
 * 实现
 * ------------------------------------------------------------------ */

export interface StudioStore {
  documents: DocumentStore
  blobs: BlobStore
  /** 读取 v1 草稿并迁移成 v2 文档；没有草稿返回 null */
  loadLegacyDocument(): Promise<SampleDocument | null>
  close(): void
}

async function estimateUsage(): Promise<{ used: number; quota: number }> {
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    const est = await navigator.storage.estimate()
    return { used: est.usage ?? 0, quota: est.quota ?? 0 }
  }
  return { used: 0, quota: 0 }
}

export function createIndexedDbStore(): StudioStore {
  let dbPromise: Promise<IDBDatabase> | null = null

  function db(): Promise<IDBDatabase> {
    if (!dbPromise) dbPromise = openStudioDb()
    return dbPromise
  }

  const documents: DocumentStore = {
    async load(sampleId) {
      const conn = await db()
      const tx = conn.transaction([STORE_DOCS, STORE_TASKS], 'readonly')
      const head = await idbRequest(tx.objectStore(STORE_DOCS).get(sampleId)) as StoredDocHead | undefined
      if (!head) return null
      const tasks: Partial<Record<TaskKey, unknown>> = {}
      const store = tx.objectStore(STORE_TASKS)
      for (const task of head.tasks) {
        const payload = await idbRequest(store.get(taskKey(sampleId, task)))
        if (payload !== undefined) tasks[task] = payload
      }
      // 读事务要等它自己完成再关连接，否则快照可能被中断
      await txDone(tx)
      return decodeDocument(head, tasks)
    },

    /**
     * 合并保存：只写本次带来的任务段，但**不抹掉**库里已有的其它段。
     * 读 head → 并集 → 同事务写回。同一样本的并发写本身由租约挡住（见方案 21.2），
     * 这里的并集是第二道防线：租约失效的瞬间也不至于把另一个任务段抹掉。
     */
    async save(doc) {
      const { head, tasks } = encodeDocument(doc)
      const conn = await db()
      const tx = conn.transaction([STORE_DOCS, STORE_TASKS], 'readwrite')
      const docStore = tx.objectStore(STORE_DOCS)
      const existing = await idbRequest(docStore.get(doc.sampleId)) as StoredDocHead | undefined
      docStore.put(mergeDocHead(existing, head), doc.sampleId)
      const store = tx.objectStore(STORE_TASKS)
      for (const item of tasks) store.put(item.payload, taskKey(doc.sampleId, item.task))
      await txDone(tx)
    },

    async saveTask(sampleId, task, payload) {
      const conn = await db()
      const tx = conn.transaction([STORE_DOCS, STORE_TASKS], 'readwrite')
      const docStore = tx.objectStore(STORE_DOCS)
      const head = await idbRequest(docStore.get(sampleId)) as StoredDocHead | undefined
      // 没有头就没有文档：此时写进去的段永远读不出来，只会变成孤儿占用空间。
      // 与其静默吞掉（下一层还会 catch 掉），不如让调用顺序错误当场暴露。
      if (!head) {
        tx.abort()
        throw new Error(`文档 ${sampleId} 尚未保存，请先 save() 再写 ${task} 段`)
      }
      // 任务段可以独立写，但头里没登记的话 load 会漏读它
      if (!head.tasks.includes(task)) {
        head.tasks = ALL_TASKS.filter((t) => t === task || head.tasks.includes(t))
        head.savedAt = Date.now()
        docStore.put(head, sampleId)
      }
      tx.objectStore(STORE_TASKS).put(encodeTask(task, payload), taskKey(sampleId, task))
      await txDone(tx)
    },

    /**
     * 删一个任务段。合并语义下 save() 只能"多写"，删必须显式来这一趟：
     * 既清 `docTasks` 里的字节，也把 head.tasks 里的登记摘掉，
     * 否则下次 load 会去取一个不存在的段（拿到 undefined，静默少任务）。
     */
    async removeTask(sampleId, task) {
      const conn = await db()
      const tx = conn.transaction([STORE_DOCS, STORE_TASKS], 'readwrite')
      const docStore = tx.objectStore(STORE_DOCS)
      const head = await idbRequest(docStore.get(sampleId)) as StoredDocHead | undefined
      if (head && head.tasks.includes(task)) {
        head.tasks = head.tasks.filter((t) => t !== task)
        head.savedAt = Date.now()
        docStore.put(head, sampleId)
      }
      tx.objectStore(STORE_TASKS).delete(taskKey(sampleId, task))
      await txDone(tx)
    },

    async listBlobRefs(): Promise<string[]> {
      const conn = await db()
      const tx = conn.transaction(STORE_TASKS, 'readonly')
      const store = tx.objectStore(STORE_TASKS)
      const out = new Set<string>()
      const cursorReq = store.openCursor()
      await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor) { resolve(); return }
          const key = String(cursor.primaryKey)
          // boxes 段是轨迹数组，没有 blob；扫它纯属浪费（可能有上千关键帧）
          if (!key.endsWith('::boxes')) collectRefsDeep(cursor.value, out)
          cursor.continue()
        }
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error('枚举任务段失败'))
      })
      await txDone(tx)
      return [...out]
    },

    async listSamples(): Promise<StoredDocumentSummary[]> {
      const conn = await db()
      const tx = conn.transaction(STORE_DOCS, 'readonly')
      const heads = await idbRequest(tx.objectStore(STORE_DOCS).getAll()) as StoredDocHead[]
      await txDone(tx)
      // 草稿列表按最近保存排序，和用户预期一致
      return heads
        .map((h) => ({
          sampleId: h.sampleId,
          sceneId: h.sceneId,
          updatedAt: h.savedAt ?? h.meta.updatedAt,
          version: h.meta.version,
          // 旧头可能没有 range（v1 迁移），原样给出 undefined 由展示层兜底
          ...(Array.isArray(h.range) ? { range: h.range } : {}),
          ...(Array.isArray(h.tasks) ? { tasks: h.tasks } : {}),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async remove(sampleId) {
      const conn = await db()
      // 只删文档与任务段。
      // blob 不按文档归属：帧点云属于"数据集"，载荷可能被多个样本共用（内容寻址）。
      // 这里删完，载荷引用随之消失，下一次 `sweepBlobs` 会把它收走 ——
      // 在存储层按认为的前缀删 blob，是 P0 遗留的错误假设（当时键还是 `sampleId#frame`）。
      const tx = conn.transaction([STORE_DOCS, STORE_TASKS], 'readwrite')
      tx.objectStore(STORE_DOCS).delete(sampleId)
      const taskStore = tx.objectStore(STORE_TASKS)
      const range = IDBKeyRange.bound(`${sampleId}::`, `${sampleId}::\uffff`)
      const cursorReq = taskStore.openKeyCursor(range)
      await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor) { resolve(); return }
          taskStore.delete(cursor.primaryKey)
          cursor.continue()
        }
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error('清理任务段失败'))
      })
      await txDone(tx)
    },

    usage: estimateUsage,
  }

  const blobs: BlobStore = {
    async put(key, buf) {
      const conn = await db()
      const tx = conn.transaction(STORE_BLOBS, 'readwrite')
      tx.objectStore(STORE_BLOBS).put({ data: buf, bytes: buf.byteLength, savedAt: Date.now() }, key)
      await txDone(tx)
    },
    async get(key) {
      const conn = await db()
      const tx = conn.transaction(STORE_BLOBS, 'readonly')
      const rec = await idbRequest(tx.objectStore(STORE_BLOBS).get(key)) as
        | { data: ArrayBuffer }
        | undefined
      await txDone(tx)
      if (!rec) throw new Error(`点云缓存不存在：${key}`)
      return rec.data
    },
    async has(key) {
      const conn = await db()
      const tx = conn.transaction(STORE_BLOBS, 'readonly')
      const count = await idbRequest(tx.objectStore(STORE_BLOBS).count(key))
      await txDone(tx)
      return count > 0
    },
    async delete(key) {
      const conn = await db()
      // 使用时间跟着字节一起删：留着它就是一条永远匹配不上任何 blob 的孤儿，
      // 下次 list 合并时白读一遍
      const tx = conn.transaction([STORE_BLOBS, STORE_USAGE], 'readwrite')
      tx.objectStore(STORE_BLOBS).delete(key)
      tx.objectStore(STORE_USAGE).delete(key)
      await txDone(tx)
    },
    async deletePrefix(prefix) {
      const conn = await db()
      const tx = conn.transaction([STORE_BLOBS, STORE_USAGE], 'readwrite')
      const store = tx.objectStore(STORE_BLOBS)
      const usage = tx.objectStore(STORE_USAGE)
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`)
      let removed = 0
      const cursorReq = store.openKeyCursor(range)
      await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor) { resolve(); return }
          store.delete(cursor.primaryKey)
          usage.delete(cursor.primaryKey)
          removed++
          cursor.continue()
        }
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error('批量删除失败'))
      })
      await txDone(tx)
      return removed
    },
    async list(prefix = '') {
      const conn = await db()
      // 两个 store 同一个只读事务：usage 与 blobs 必须看到同一个瞬间的状态，
      // 分两次事务的话中间可能刚被清扫过，合并结果就自相矛盾
      const tx = conn.transaction([STORE_BLOBS, STORE_USAGE], 'readonly')
      const store = tx.objectStore(STORE_BLOBS)
      const usageStore = tx.objectStore(STORE_USAGE)
      const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}\uffff`) : null
      const cursorReq = range ? store.openCursor(range) : store.openCursor()
      const out: BlobMeta[] = []
      await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor) { resolve(); return }
          const rec = cursor.value as { bytes?: number; savedAt?: number; data?: ArrayBuffer }
          out.push({
            key: String(cursor.primaryKey),
            // 旧记录没有 bytes 字段，用 buffer 长度兜底
            bytes: rec.bytes ?? rec.data?.byteLength ?? 0,
            savedAt: rec.savedAt ?? 0,
          })
          cursor.continue()
        }
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error('枚举 blob 失败'))
      })

      // 合并使用时间与命中次数。没有记录的老键退回 savedAt —— 它至少是"写入时间"，
      // 比 0（永不过期）更接近真相，也让升级前的缓存能正常参与淘汰。
      const usageMap = new Map<string, { at: number; hits: number }>()
      const usageReq = range ? usageStore.openCursor(range) : usageStore.openCursor()
      await new Promise<void>((resolve, reject) => {
        usageReq.onsuccess = () => {
          const cursor = usageReq.result
          if (!cursor) { resolve(); return }
          const rec = cursor.value as { at?: number; hits?: number } | number | undefined
          // v3 早期记录只存了数字或 `{at}`：都当作"命中 0 次"
          if (typeof rec === 'number') usageMap.set(String(cursor.primaryKey), { at: rec, hits: 0 })
          else if (rec && typeof rec.at === 'number') {
            usageMap.set(String(cursor.primaryKey), {
              at: rec.at,
              hits: Number.isFinite(rec.hits) ? rec.hits as number : 0,
            })
          }
          cursor.continue()
        }
        usageReq.onerror = () => reject(usageReq.error ?? new Error('枚举使用时间失败'))
      })
      await txDone(tx)

      for (const meta of out) {
        const usage = usageMap.get(meta.key)
        meta.lastUsedAt = Math.max(meta.savedAt, usage?.at ?? 0)
        meta.hits = usage?.hits ?? 0
      }
      return out
    },

    /**
     * 批量记一次使用：刷新时间**并**累加命中次数。同事务写完，一次几百字节。
     * 不存在的键跳过：可能刚被清扫掉，给一个不存在的键记时间毫无意义。
     *
     * 【为什么要先 get 再 put】IndexedDB 没有"字段自增"，命中次数只能读改写。
     * 一条记录只有 {at, hits} 两个数字，读的代价可以忽略；
     * 这也是当初把元数据从 blobs 里拆出来的原因（那边一条是 1.8MB 的 buffer）。
     */
    async touchMany(keys, at = Date.now()) {
      if (!keys.length) return 0
      const conn = await db()
      const tx = conn.transaction([STORE_BLOBS, STORE_USAGE], 'readwrite')
      const blobs = tx.objectStore(STORE_BLOBS)
      const usage = tx.objectStore(STORE_USAGE)
      let touched = 0
      for (const key of keys) {
        const exists = await idbRequest(blobs.count(key))
        if (!exists) continue
        const prev = await idbRequest(usage.get(key)) as { hits?: number } | number | undefined
        const hits = typeof prev === 'number' ? 0 : (prev?.hits ?? 0)
        usage.put({ at, hits: hits + 1 }, key)
        touched++
      }
      await txDone(tx)
      return touched
    },
    async deleteMany(keys) {
      if (!keys.length) return 0
      const conn = await db()
      const tx = conn.transaction([STORE_BLOBS, STORE_USAGE], 'readwrite')
      const store = tx.objectStore(STORE_BLOBS)
      const usage = tx.objectStore(STORE_USAGE)
      for (const key of keys) {
        store.delete(key)
        usage.delete(key)
      }
      await txDone(tx)
      return keys.length
    },
    usage: estimateUsage,
  }

  return {
    documents,
    blobs,
    async loadLegacyDocument() {
      const conn = await db()
      const tx = conn.transaction(STORE_SESSION, 'readonly')
      const snapshot = await idbRequest(tx.objectStore(STORE_SESSION).get('current')) as
        | SessionSnapshot
        | undefined
      await txDone(tx)
      if (!snapshot || snapshot.version !== 1) return null
      return migrateLegacySnapshot(snapshot)
    },
    close() {
      void dbPromise?.then((conn) => conn.close()).catch(() => { /* 打不开就没得关 */ })
      dbPromise = null
    },
  }
}

/** 诊断用：库名与版本，状态栏/测试里显示 */
export const STORE_INFO = { name: DB_NAME, version: 3, stores: [STORE_SESSION, STORE_DOCS, STORE_TASKS, STORE_BLOBS, STORE_USAGE] }
