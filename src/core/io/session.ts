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
import type { Box3D, ObjectCategory, PointCloud, SemanticClass, SemanticLabels } from '../types'

const DB_NAME = 'point-cloud-label-studio'
const DB_VERSION = 1
const STORE = 'session'
const KEY = 'current'

export interface StoredCloud {
  positions: Float32Array
  colors?: Float32Array
  labels?: SemanticLabels
  semanticClasses?: SemanticClass[]
  count: number
}

export interface StoredFrame {
  index: number
  name?: string
  cloud: StoredCloud
  boxes: Box3D[]
}

export interface SessionSnapshot {
  version: 1
  savedAt: number
  /** 数据集显示名，用于状态栏与恢复提示 */
  datasetName: string
  /** 当前帧的点云（frames 为空时使用） */
  cloud: StoredCloud | null
  frames: StoredFrame[]
  currentFrame: number
  boxes: Box3D[]
  categories: ObjectCategory[]
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中断'))
  })
}

/** 把 PointCloud 转成可结构化克隆的精简对象（不拷贝 Buffer 之外的东西） */
export function toStoredCloud(cloud: PointCloud): StoredCloud {
  return {
    positions: cloud.positions,
    ...(cloud.colors ? { colors: cloud.colors } : {}),
    ...(cloud.labels ? { labels: cloud.labels } : {}),
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
    ...(stored.semanticClasses ? { semanticClasses: stored.semanticClasses } : {}),
  }
}

export async function saveSession(snapshot: Omit<SessionSnapshot, 'version' | 'savedAt'>): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ ...snapshot, version: 1, savedAt: Date.now() }, KEY)
    await txDone(tx)
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
    tx.objectStore(STORE).delete(KEY)
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
    bytes += c.positions.byteLength + (c.colors?.byteLength ?? 0) + (c.labels?.byteLength ?? 0)
  }
  add(snapshot.cloud)
  for (const f of snapshot.frames) add(f.cloud)
  return bytes
}
