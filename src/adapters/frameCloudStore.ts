/**
 * ============================================================
 * 适配器：逐帧点云缓存（供草稿断点续标）
 * ============================================================
 *
 * 【为什么懒加载数据集仍然要落盘点云】
 *   懒加载解决的是"内存里不能装 500 帧"，但刷新页面后，已解码帧如果没落盘，
 *   用户重新打开草稿会看到"框都在、点云全空"——这比慢更糟。
 *   所以策略是：**解码一帧就异步落盘一帧**，下次恢复时能直接读回来。
 *   没解码过的帧本来就没在编辑器里看过，恢复后显示"待解码"是符合直觉的。
 *
 * 【为什么一个帧存 3 条记录而不是打包成一条】
 *   `BlobStore` 的契约是 `ArrayBuffer`。把 positions/colors/labels 打包成一条
 *   需要自定义容器格式（长度头 + 三段），解析代码必须与写入代码严格对称，
 *   一个字段顺序改错就静默读出乱码。分开存三条，代价是 3 次事务，
 *   收益是"读不出来就是没有"，不会产生错位数据。
 *
 * 【诚实边界】
 *   这里只负责读写，不做去留判断：哪一帧该留、哪个数据集该清，由
 *   `adapters/blobGc.ts` 统一决定（它需要同时看草稿指针与历史引用）。
 *   键规范见 `adapters/blobKeys.ts`。
 */
import type { PointCloud } from '../core/types'
import type { SampleHandle } from '../ports/dataSource'
import type { SceneMeta } from '../domain/model/scene'
import { frameBlobKey, frameZonePrefix, legacyFrameBlobKey, legacyFramePrefix } from './blobKeys'
import { studioStore } from './studioStore'

const COLORS_SUFFIX = ':colors'
const LABELS_SUFFIX = ':labels'

/* ------------------------------------------------------------------
 * 使用时间（LRU 判据）
 * ------------------------------------------------------------------
 * 【为什么在读路径上记账】淘汰策略要问"这一帧最久没被看是什么时候"。
 *   写入时间（savedAt）回答的是"第一次解码它的时间"，回看不会刷新它 ——
 *   按那个排序淘汰，删掉的是"最早看过的"，恰好是封面帧与开头。
 *
 * 【为什么要攒批】回放时每 100ms 切一帧，每次读都写一次库
 *   会在主线程上排队几十个几十字节的事务，把切帧顶出 16ms 的预算。
 *   攒 800ms 合并成一次；同一帧 60 秒内不重复记（LRU 的精度按分钟就够）。
 *
 * 【为什么 60 秒窗口同时是 LFU 的口径】
 *   `touchMany` 每次调用把命中次数 +1。若不加窗口，10Hz 回放看 10 秒
 *   就能把一帧刷到 100 次 —— 那不是"看了多少回"，而是"停留了多久"。
 *   60 秒窗口把计数压成"回看的次数"，这才是 LFU 想要的频次。
 */
const TOUCH_DEBOUNCE_MS = 800
const TOUCH_MIN_GAP_MS = 60_000
const TOUCH_MEMORY_LIMIT = 4000

const pendingUse = new Map<string, number>()
const lastTouch = new Map<string, number>()
let touchTimer: ReturnType<typeof setTimeout> | null = null

/** 记一次"这帧被读了"。不返回 Promise：读路径不该等元数据写完 */
export function noteFrameUsed(datasetKey: string, frame: number): void {
  if (!datasetKey) return
  const key = frameBlobKey(datasetKey, frame)
  const now = Date.now()
  const prev = lastTouch.get(key)
  if (prev !== undefined && now - prev < TOUCH_MIN_GAP_MS) return
  pendingUse.set(key, now)
  if (touchTimer !== null) return
  touchTimer = setTimeout(() => {
    void flushFrameUse()
  }, TOUCH_DEBOUNCE_MS)
}

/**
 * 立刻把攒下的使用时间写进库。返回写入条数。
 * 失败静默：这是淘汰判据的精度问题，不是业务数据 —— 丢掉最多让一帧晚点被淘汰。
 */
export async function flushFrameUse(): Promise<number> {
  if (touchTimer !== null) {
    clearTimeout(touchTimer)
    touchTimer = null
  }
  if (!pendingUse.size) return 0
  const store = studioStore()
  const keys = [...pendingUse.keys()]
  // 同一批用同一个时间戳：这批的间隔不超过 800ms，对"按分钟精度"的 LRU 没有区别
  const at = Math.max(...pendingUse.values())
  pendingUse.clear()
  if (!store) return 0
  try {
    const n = await store.blobs.touchMany(keys, at)
    for (const key of keys) lastTouch.set(key, at)
    if (lastTouch.size > TOUCH_MEMORY_LIMIT) {
      // 只保留最近的一半：内存表只是"别写太勤"的缓存，丢了对正确性没有影响
      const sorted = [...lastTouch.entries()].sort((a, b) => a[1] - b[1])
      for (let i = 0; i < sorted.length - TOUCH_MEMORY_LIMIT / 2; i++) lastTouch.delete(sorted[i][0])
    }
    return n
  } catch {
    return 0
  }
}

function toArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  // 解析产出的 TypedArray 通常是独占 buffer，直接返回可省一次 1.8MB 拷贝；
  // 只有子视图（byteOffset>0 或长度不等）才必须切片
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view.buffer as ArrayBuffer
  }
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}

/**
 * 把一帧点云写进 IndexedDB。
 * 失败静默：缓存是尽力而为，不能因为"存不下"打断标注。
 */
export async function saveFrameCloud(datasetKey: string, frame: number, cloud: PointCloud): Promise<void> {
  const store = studioStore()
  if (!store || !datasetKey || cloud.count === 0) return
  const key = frameBlobKey(datasetKey, frame)
  await store.blobs.put(key, toArrayBuffer(cloud.positions))
  if (cloud.colors) await store.blobs.put(`${key}${COLORS_SUFFIX}`, toArrayBuffer(cloud.colors))
  if (cloud.labels) await store.blobs.put(`${key}${LABELS_SUFFIX}`, toArrayBuffer(cloud.labels))
}

/** 按给定键读一帧；缺 positions 返回 null（部分帧可能只有颜色，视作损坏） */
async function readCloudAt(
  store: NonNullable<ReturnType<typeof studioStore>>,
  key: string,
): Promise<PointCloud | null> {
  if (!(await store.blobs.has(key))) return null
  const positions = new Float32Array(await store.blobs.get(key))
  if (!positions.length) return null
  const out: PointCloud = { positions, count: positions.length / 3 }
  if (await store.blobs.has(`${key}${COLORS_SUFFIX}`)) {
    out.colors = new Float32Array(await store.blobs.get(`${key}${COLORS_SUFFIX}`))
  }
  if (await store.blobs.has(`${key}${LABELS_SUFFIX}`)) {
    out.labels = new Uint16Array(await store.blobs.get(`${key}${LABELS_SUFFIX}`))
  }
  return out
}

/**
 * 读回一帧点云；没有缓存返回 null（不抛错，调用方据此显示"待解码"）。
 *
 * 先试新键，再试 P0 的旧键：用户升级前缓存的帧仍然要能读出来，
 * 而旧键没有重写的必要 —— 写一次就永远不会再变，读时多一次 `has` 而已。
 */
export async function loadFrameCloud(datasetKey: string, frame: number): Promise<PointCloud | null> {
  const store = studioStore()
  if (!store || !datasetKey) return null
  try {
    const fresh = await readCloudAt(store, frameBlobKey(datasetKey, frame))
    if (fresh) {
      // 命中就记一笔：这是"最久未用"判据的唯一来源
      noteFrameUsed(datasetKey, frame)
      return fresh
    }
    // 旧键读出来的不记：旧键反解不出数据集，参与不了 LRU，记了也没人看
    return await readCloudAt(store, legacyFrameBlobKey(datasetKey, frame))
  } catch {
    // 记录损坏时当作没有缓存，而不是让草稿打不开
    return null
  }
}

/** 删除某个数据集的全部帧缓存（清除草稿时调用）。新键与旧键一起清 */
export async function clearDatasetClouds(datasetKey: string): Promise<number> {
  const store = studioStore()
  if (!store || !datasetKey) return 0
  const removedFresh = await store.blobs.deletePrefix(frameZonePrefix(datasetKey))
  const removedLegacy = await store.blobs.deletePrefix(legacyFramePrefix(datasetKey))
  return removedFresh + removedLegacy
}

/**
 * 把"草稿里缓存过的帧"包装成一个 DataSource 句柄，交给 FrameLoader 统一调度。
 *
 * 这样恢复草稿后，切帧路径与"刚导入文件"完全一致：
 *   命中 → 显示；未命中 → 抛错 → 状态栏提示"请重新导入"。
 * 不需要在 restore 里写第二套懒加载逻辑。
 */
export function createCachedCloudHandle(datasetKey: string, frameIndexes: number[]): SampleHandle {
  const meta: SceneMeta = {
    id: datasetKey || 'restored',
    name: '草稿恢复 · 点云缓存',
    sensors: [{ id: 'lidar_top', kind: 'lidar' }],
    nominalHz: 10,
    calibrationVersion: 'none',
  }
  return {
    meta: () => meta,
    /**
     * 这个句柄只读缓存：源文件早就不在了，帧缓存就是唯一副本。
     * 声明成不可重解码，GC 的 LRU 阶段就会绕开它 —— 淘汰它等于删数据。
     */
    reloadable: false,
    async frame(i) {
      const frame = frameIndexes[i] ?? i
      const cloud = await loadFrameCloud(datasetKey, frame)
      if (!cloud) throw new Error('点云未缓存')
      return {
        ref: {
          index: frame,
          ts: frame / meta.nominalHz,
          data: { lidar_top: { kind: 'inline', cloud } },
        },
        cloud,
      }
    },
    async calibrations() {
      return {}
    },
    close() {
      /* 无外部资源 */
    },
  }
}
