/**
 * ============================================================
 * 占据帧的存储与装载
 * ============================================================
 *
 * 与点云帧的区别，决定了这里为什么不做"位置键 + 批量清前缀"：
 *   点云帧导入后不再变化，键 = `frames/<dataset>/<n>`，按数据集整批删最省事；
 *   占据帧会被 ROI 编辑改掉，而且**同一帧的不同版本都要活着**（撤销要用）。
 *   所以走内容寻址：`payload/<hash>`，改一格就换一个键，旧键由命令持有，
 *   撤销 = 切回旧引用，天然幂等。
 *
 * 【为什么写之前不查重旧帧】
 *   `putPayload` 已经按内容去重。同一帧原样重算（比如重跑派生但结果相同）
 *   不会写第二份字节 —— 这也是"重跑派生不会把库撑大"的原因。
 */
import type { BlobStore } from '../ports/blobStore'
import { getPayload, putPayload } from './blobPayload'
import { decodeOccRle, encodeOccRle, type OccupancyFrame } from '../domain/derive/occupancy'
import type { OccupancyTaskData } from '../domain/model/document'

/** 写一帧占据，返回 payload 键 */
export async function putOccFrame(blobs: BlobStore, frame: OccupancyFrame): Promise<string> {
  return putPayload(blobs, encodeOccRle(frame))
}

export async function getOccFrame(blobs: BlobStore, ref: string): Promise<OccupancyFrame> {
  return decodeOccRle(await getPayload(blobs, ref))
}

/** 从描述对象里取帧引用表（按帧号升序，方便 UI 显示"覆盖 0–4 帧"） */
export function occFrameEntries(task: OccupancyTaskData | undefined): Array<{ frame: number; ref: string }> {
  const list = task?.frames ?? []
  return [...list].sort((a, b) => a.frame - b.frame)
}
