/**
 * ============================================================
 * 适配器：整段序列流式导出
 * ============================================================
 *
 * 【为什么不用 `serializeSequence`】
 *   那个函数先 `frames.map(...)` 造出 500 × 200 = 10 万个对象数组，
 *   再 `JSON.stringify(..., null, 2)` 生成一个几十 MB 的字符串。
 *   峰值内存是数据量的 3~4 倍（对象数组 + 中间字符串 + 最终 Blob），
 *   500 帧 100 轨迹在低配机器上会直接触发 GC 抖动甚至 OOM。
 *
 *   这里改成"按帧物化 → 按块序列化"：
 *     - 帧来自 `TrackStore.materializeAll()` 的 generator，用完就回收；
 *     - 每 8 帧拼成一个 chunk 字符串，拼完立刻交给 Blob；
 *     - 全程不存在"整段对象数组"和"整段 JSON 字符串"。
 *
 * 【为什么不写成真正的 ReadableStream】
 *   下载仍要一个完整 Blob（没有 File System Access API 时，`a.download`
 *   只能吃 Blob）。所以峰值仍在，但少了两次全量拷贝 —— 且 chunk 之间互不引用，
 *   GC 可以边写边收。等接入服务端上传/分片下载时，这个 generator 可以直接
 *   换成流式写，不需要改调用方。
 *
 * 【为什么导出走真值而不是 frames 镜像】
 *   镜像是"看过的帧的缓存"，文档才是真值。走 `materializeAll` 还有两个好处：
 *   1. 能按 `mode: 'linear'` 补齐中间帧 —— 训练数据要的是逐帧连续轨迹；
 *   2. 帧范围来自 `document.range`，不会因为"没翻到最后一帧"而少导。
 */
import type { Box3D } from '../core/types'
import { toRawLabel } from '../core/io/label'
import type { MaterializeOptions } from '../domain/store/materialize'
import type { TrackStore } from '../domain/store/trackStore'

export const SEQUENCE_FORMAT = 'pcl-label-studio/sequence'

export interface SequenceExportOptions {
  /**
   * 物化选项。默认 `exact`（只出关键帧），与 frames 镜像等价；
   * 导出给训练用请传 `{ mode: 'linear' }`，中间帧才会补齐。
   */
  materialize?: MaterializeOptions
  /** 每个 chunk 多少帧。默认 8：单块约几十 KB，既能摊薄 JSON 开销又不撑爆内存 */
  framesPerChunk?: number
}

/**
 * 逐块产出整段序列 JSON。
 *
 * 产出顺序是"头 + N 个帧块 + 尾"，直接按顺序拼接就是合法 JSON；
 * 调用方可以边产边写（Blob parts / 上传流），不需要等全部帧物化完。
 */
export function* serializeSequenceChunks(
  store: Pick<TrackStore, 'materializeAll' | 'document'>,
  opts: SequenceExportOptions = {},
): Generator<string, void, void> {
  const perChunk = Math.max(1, Math.floor(opts.framesPerChunk ?? 8))
  const [from, to] = store.document.range
  const total = Math.max(0, to - from + 1)
  const exportedAt = new Date().toISOString()

  yield (
    `{"format":${JSON.stringify(SEQUENCE_FORMAT)},"version":1,` +
    `"exportedAt":${JSON.stringify(exportedAt)},"frameCount":${total},"frames":[`
  )

  let buf: string[] = []
  let first = true
  for (const { frame, boxes } of store.materializeAll(opts.materialize)) {
    // 单帧内部仍是一次 stringify：一帧对象的体量是可控的（通常 < 200KB）
    const objects = (boxes as Box3D[]).map(toRawLabel)
    buf.push(`${first ? '' : ','}{"index":${frame},"objects":${JSON.stringify(objects)}}`)
    first = false
    if (buf.length >= perChunk) {
      yield buf.join('')
      buf = []
    }
  }
  if (buf.length) yield buf.join('')
  yield ']}'
}

/** 把流式块收成 Blob（浏览器下载用；Node 测试里也能构造） */
export function sequenceBlob(
  store: Pick<TrackStore, 'materializeAll' | 'document'>,
  opts: SequenceExportOptions = {},
): Blob {
  return new Blob([...serializeSequenceChunks(store, opts)], { type: 'application/json' })
}
