/**
 * ============================================================
 * PCD 解析 worker
 * ============================================================
 *
 * 【为什么必须搬进 worker】
 *   `parsePCD` 对一个 15 万点的 binary 文件要做 15 万次 DataView 读取，
 *   主线程上大约 120–250ms；100 万点接近 1.4 秒（docs/07 实测）。
 *   在"打开序列 → 逐帧翻"的路径上，这个耗时全部落在用户点击后的响应里，
 *   表现就是"点一下卡一下、拖视角也卡"。
 *   放进 worker 后主线程只做一次 `postMessage` 和一次几何上传。
 *
 * 【为什么输出用 transferable】
 *   `positions` / `colors` / `labels` 是 TypedArray。
 *   不用 transfer 的话结构化克隆会复制一遍，15 万点 = 1.8MB，翻 100 帧就是 180MB 垃圾。
 *   transfer 是零拷贝移交，代价是 worker 侧这些 buffer 会失效 —— 而 worker
 *   本来解析完就丢掉，所以没有副作用。
 *
 * 【为什么不在这里做下采样】
 *   下采样策略（体素尺寸、距离 LOD）依赖 UI 状态，worker 不该知道这些。
 *   等 P2 需要时再加一条 `downsample` 消息类型，而不是把策略写死在解析里。
 */
import { parsePCD } from '../core/io/pcd'
import type { SemanticLabels } from '../core/types'

interface ParseRequest {
  id: number
  buffer: ArrayBuffer
}

interface ParseResponse {
  id: number
  ok: boolean
  count?: number
  positions?: Float32Array
  colors?: Float32Array
  labels?: SemanticLabels
  /** 语义实例 id（PCD 里没有，保留字段位，未来由 .label 合并时填） */
  error?: string
}

// worker 环境没有 DOM 的 Window 类型，用最小接口避免 lib.dom 与 lib.webworker 冲突
const ctx = self as unknown as {
  postMessage: (msg: ParseResponse, transfer?: Transferable[]) => void
  onmessage: ((e: MessageEvent<ParseRequest>) => void) | null
}

ctx.onmessage = (e: MessageEvent<ParseRequest>) => {
  const { id, buffer } = e.data
  try {
    const cloud = parsePCD(buffer)
    const transfer: Transferable[] = [cloud.positions.buffer]
    if (cloud.colors) transfer.push(cloud.colors.buffer)
    if (cloud.labels) transfer.push(cloud.labels.buffer)
    ctx.postMessage({
      id,
      ok: true,
      count: cloud.count,
      positions: cloud.positions,
      ...(cloud.colors ? { colors: cloud.colors } : {}),
      ...(cloud.labels ? { labels: cloud.labels } : {}),
    }, transfer)
  } catch (err) {
    // 解析错误是数据问题（头部损坏、binary_compressed），必须回传而不是让 worker 崩掉：
    // worker 崩掉时主线程只知道 onerror，拿不到是哪一帧、为什么。
    ctx.postMessage({ id, ok: false, error: (err as Error).message })
  }
}
