/**
 * ============================================================
 * 本地草稿持久化 —— IndexedDB
 * ============================================================
 * 标注工具最不能接受的事故是「刷新一下，半小时的活没了」。
 * CVAT / Label Studio 都靠服务端草稿兜底；单机版用 IndexedDB 做同一件事。
 *
 * 存什么：当前数据集（点云 + 帧序列）、当前帧标注、类别配置、帧号。
 * 不存什么：撤销栈（跨会话恢复历史没有意义，而且快照很占空间）。
 *
 * 为什么用 IndexedDB 而不是 localStorage：
 *   localStorage 只收字符串，Float32Array 要先转 base64，体积涨 33% 且同步阻塞；
 *   IndexedDB 直接结构化克隆 TypedArray，几十 MB 也能存。
 */
import type { Box3D, InstanceIds, ObjectCategory, PointCloud, SemanticClass, SemanticLabels } from '../types'
import { STORE_SESSION, openStudioDb, txDone } from './idb'

/**
 * v1 草稿结构。**保留，但不再扩展**：
 *   v2 的文档模型在 `domain/model/document.ts`，落盘在 `adapters/indexedDbStore.ts`。
 *   这个文件现在的职责只剩两件：
 *     1. 读旧草稿（用户升级前的数据不能丢）；
 *     2. 作为 v2 落地前的兼容快照格式（`useStudio.buildSnapshot`）。
 *   库版本已由 `idb.ts` 统一升到 2，`session` store 本身不变。
 */
const STORE = STORE_SESSION
const KEY = 'current'

/**
 * 草稿指针：极小的旁路记录，给垃圾回收看。
 *
 * 为什么不在 GC 时直接 `loadSession()`：快照里可能有几十 MB 点云，
 * 为了知道"草稿属于哪个数据集"而反序列化它，等于每次回收都卡一次主线程。
 * 指针只有几十字节，且与快照在**同一个事务**里写，不会出现两者不一致。
 */
const POINTER_KEY = 'draft-meta'

export interface DraftPointer {
  /** 帧缓存的数据集键；空串表示这个样本的点云没有逐帧落盘（演示/单帧导入） */
  datasetKey: string
  datasetName: string
  savedAt: number
  /**
   * v2 文档 id，doc-first 恢复的入口。
   *
   * 为什么放在指针里而不是"恢复时按场景名拼"：`sampleId` 是
   * `sceneId#start-end`，帧数相同的两个数据集会撞号；只有"这次保存到底写了哪份文档"
   * 这个事实是准的。指针与快照在同一个事务里写，不会互相指错。
   */
  sampleId?: string
  /** 快照里的帧数，用于恢复前先给个进度印象（不必解文档） */
  frameCount?: number
}

export interface StoredCloud {
  positions: Float32Array
  colors?: Float32Array
  labels?: SemanticLabels
  instances?: InstanceIds
  semanticClasses?: SemanticClass[]
  count: number
}

export interface StoredFrame {
  index: number
  name?: string
  cloud: StoredCloud
  boxes: Box3D[]
  /**
   * 该帧点云来自懒加载数据源且未落盘。
   * 恢复时据此显示"待解码"，而不是把空点云当成真的空场景。
   */
  lazy?: boolean
}

export interface SessionSnapshot {
  version: 1
  savedAt: number
  /** 数据集显示名，用于状态栏与恢复提示 */
  datasetName: string
  /** 懒加载缓存键（`local#文件名#帧数`）；用于恢复时回读逐帧点云 */
  datasetKey?: string
  /** 对应的 v2 文档 id；doc-first 恢复时用它校验收到的文档是不是这一份 */
  sampleId?: string
  /**
   * 点云存放方式：
   *   `inline` 点云在下面各帧里（默认，小数据集）；
   *   `spill`  点云只在 blob store，快照只留"封面帧 + 当前帧"，其余帧标 `lazy`。
   * 记下来是为了排障：看到 `spill` 却回读失败，说明帧缓存被清了，不是逻辑写错。
   */
  cloudMode?: 'inline' | 'spill'
  /** 当前帧的点云（frames 为空时使用） */
  cloud: StoredCloud | null
  frames: StoredFrame[]
  currentFrame: number
  boxes: Box3D[]
  categories: ObjectCategory[]
}

const openDb = openStudioDb

/** 把 PointCloud 转成可结构化克隆的精简对象（不拷贝 Buffer 之外的东西） */
export function toStoredCloud(cloud: PointCloud): StoredCloud {
  return {
    positions: cloud.positions,
    ...(cloud.colors ? { colors: cloud.colors } : {}),
    ...(cloud.labels ? { labels: cloud.labels } : {}),
    ...(cloud.instances ? { instances: cloud.instances } : {}),
    ...(cloud.semanticClasses ? { semanticClasses: cloud.semanticClasses } : {}),
    count: cloud.count,
  }
}

export function fromStoredCloud(stored: StoredCloud): PointCloud {
  return {
    positions: stored.positions,
    count: stored.count,
    ...(stored.colors ? { colors: stored.colors } : {}),
    ...(stored.labels ? { labels: stored.labels } : {}),
    ...(stored.instances ? { instances: stored.instances } : {}),
    ...(stored.semanticClasses ? { semanticClasses: stored.semanticClasses } : {}),
  }
}

export async function saveSession(snapshot: Omit<SessionSnapshot, 'version' | 'savedAt'>): Promise<void> {
  const db = await openDb()
  try {
    // 快照与指针同事务：GC 读到的指针一定对应当前快照，
    // 否则会出现"指针说 A、快照其实是 B"，于是把 B 的缓存删掉。
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const savedAt = Date.now()
    store.put({ ...snapshot, version: 1, savedAt }, KEY)
    // 指针的触发条件从"有 datasetKey"改成"有 datasetKey 或 sampleId"：
    // 演示/单帧样本没有帧缓存，但有 v2 文档，doc-first 恢复同样需要入口。
    if (snapshot.datasetKey || snapshot.sampleId) {
      const pointer: DraftPointer = {
        datasetKey: snapshot.datasetKey ?? '',
        datasetName: snapshot.datasetName,
        savedAt,
        ...(snapshot.sampleId ? { sampleId: snapshot.sampleId } : {}),
        ...(snapshot.frames.length ? { frameCount: snapshot.frames.length } : {}),
      }
      store.put(pointer, POINTER_KEY)
    } else {
      // 演示/单帧数据集没有帧缓存，指针留着会让 GC 误以为还有活数据集
      store.delete(POINTER_KEY)
    }
    await txDone(tx)
  } finally {
    db.close()
  }
}

export async function loadDraftPointer(): Promise<DraftPointer | null> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readonly')
    const value = await new Promise<DraftPointer | undefined>((resolve, reject) => {
      const req = tx.objectStore(STORE).get(POINTER_KEY)
      req.onsuccess = () => resolve(req.result as DraftPointer | undefined)
      req.onerror = () => reject(req.error ?? new Error('读取草稿指针失败'))
    })
    await txDone(tx)
    // 只校验 datasetKey 的类型（空串是合法值：表示"有草稿但没有帧缓存"）。
    // 以前这里要求非空，导致 sampleId-only 的草稿永远读不出指针。
    if (!value || typeof value.datasetKey !== 'string') return null
    return value
  } finally {
    db.close()
  }
}

export async function loadSession(): Promise<SessionSnapshot | null> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(KEY)
    const value = await new Promise<SessionSnapshot | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as SessionSnapshot | undefined)
      req.onerror = () => reject(req.error ?? new Error('读取草稿失败'))
    })
    await txDone(tx)
    if (!value || value.version !== 1) return null
    return value
  } finally {
    db.close()
  }
}

export async function clearSession(): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    store.delete(KEY)
    // 指针必须一起清：否则下次 GC 会以为那个数据集的缓存还有人用
    store.delete(POINTER_KEY)
    await txDone(tx)
  } finally {
    db.close()
  }
}

/**
 * 只清草稿指针，保留快照。
 *
 * 【什么时候需要】样本列表里删掉了一份文档，而草稿指针正好指着它。
 *   此时不能调 `clearSession()` —— 那会把**当前**这份没删的草稿一起清掉。
 *   只摘指针的后果很轻：下次启动拿不到 sampleId，退回按快照自身的数据集恢复。
 *
 * 【为什么不顺手清快照】指针与快照本来就可能不同源（指针指向 v2 文档、
 *   快照只提供帧布局）。没有证据表明快照属于被删的样本时，别替用户做删除决定。
 */
export async function clearDraftPointer(): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(POINTER_KEY)
    await txDone(tx)
  } finally {
    db.close()
  }
}

/** 粗略估算快照体积，用于超大数据集时跳过自动保存 */
export function estimateSnapshotBytes(snapshot: Pick<SessionSnapshot, 'cloud' | 'frames'>): number {
  let bytes = 0
  const add = (c: StoredCloud | null) => {
    if (!c) return
    bytes +=
      c.positions.byteLength +
      (c.colors?.byteLength ?? 0) +
      (c.labels?.byteLength ?? 0) +
      (c.instances?.byteLength ?? 0)
  }
  add(snapshot.cloud)
  for (const f of snapshot.frames) add(f.cloud)
  return bytes
}
