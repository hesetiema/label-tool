/**
 * ============================================================
 * 标注结果序列化 —— 与原仓库 SUSTechPOINTS 格式互通
 * ============================================================
 *
 * 标注工具的价值一半在"标"，一半在"能导出成算法认识的格式"。
 * 这里实现 Box3D <-> SUSTechPOINTS label JSON 的双向转换，
 * 以及多帧序列的整体导出（生产环境会换成 zip / 对象存储，这里保持单文件可读）。
 */
import type { Box3D, RawLabelObject } from '../types'
import { boxToVertices } from '../geometry/box'

/** 内部模型 → SUSTechPOINTS JSON 对象 */
export function toRawLabel(box: Box3D): RawLabelObject {
  return {
    psr: {
      position: { ...box.position },
      scale: { ...box.scale },
      // 原仓库 rotation 是 Euler 的 x/y/z；本工具只支持绕 z 的 yaw
      rotation: { x: 0, y: 0, z: box.yaw },
    },
    obj_type: box.label,
    obj_id: box.id,
    vertices: boxToVertices(box),
    ...(box.visibility && box.visibility !== 'visible' ? { visibility: box.visibility } : {}),
    ...(box.attributes && Object.keys(box.attributes).length ? { attributes: box.attributes } : {}),
  }
}

/** SUSTechPOINTS JSON 对象 → 内部模型 */
export function fromRawLabel(raw: RawLabelObject): Box3D {
  return {
    id: String(raw.obj_id),
    label: raw.obj_type,
    position: { ...raw.psr.position },
    scale: { ...raw.psr.scale },
    // 只取 yaw；若源数据带 roll/pitch，会被压平（本工具的模型不支持）
    yaw: raw.psr.rotation.z,
    ...(raw.visibility ? { visibility: raw.visibility } : {}),
    ...(raw.attributes ? { attributes: { ...raw.attributes } } : {}),
  }
}

/** 导出单帧标注为 JSON 字符串（可直接保存为 label/000970.json） */
export function serializeLabels(boxes: Box3D[]): string {
  return JSON.stringify(boxes.map(toRawLabel), null, 2)
}

/** 从 JSON 字符串解析出所有框（仅 SUSTechPOINTS 原生格式；多格式见 io/formats） */
export function parseLabels(json: string): Box3D[] {
  const raws: unknown = JSON.parse(json)
  if (!Array.isArray(raws)) throw new Error('标注文件应为对象数组')
  return (raws as RawLabelObject[]).map(fromRawLabel)
}


/** 序列导出格式：一帧一个 objects 数组，字段仍是 SUSTechPOINTS 的对象结构 */
export interface SequenceExport {
  format: 'pcl-label-studio/sequence'
  version: 1
  exportedAt: string
  frameCount: number
  frames: {
    index: number
    name?: string
    objects: RawLabelObject[]
  }[]
}

/**
 * 把整段序列导出成单个 JSON。
 * 为什么不做 zip：没有压缩库时自己写 zip 容易出错，
 * 而"单文件 + 每帧 objects"已经能被脚本一行拆开，学习场景够用。
 */
export function serializeSequence(
  frames: { index: number; name?: string; boxes: Box3D[] }[],
): string {
  const payload: SequenceExport = {
    format: 'pcl-label-studio/sequence',
    version: 1,
    exportedAt: new Date().toISOString(),
    frameCount: frames.length,
    frames: frames.map((f) => ({
      index: f.index,
      ...(f.name ? { name: f.name } : {}),
      objects: f.boxes.map(toRawLabel),
    })),
  }
  return JSON.stringify(payload, null, 2)
}

/** 读取序列导出文件；也兼容直接给单帧数组的情况 */
export function parseSequence(json: string): { index: number; boxes: Box3D[] }[] {
  const data = JSON.parse(json) as SequenceExport | RawLabelObject[]
  if (Array.isArray(data)) return [{ index: 0, boxes: data.map(fromRawLabel) }]
  if (data?.format !== 'pcl-label-studio/sequence') throw new Error('不是本工具的序列标注文件')
  return data.frames.map((f) => ({ index: f.index, boxes: f.objects.map(fromRawLabel) }))
}

/** 触发浏览器下载任意 Blob（JSON / 视频共用） */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // 下一帧再释放，Safari 对同步 revoke 偶发下载失败
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 触发浏览器下载 JSON 文件 */
export function downloadJson(filename: string, content: string): void {
  downloadBlob(filename, new Blob([content], { type: 'application/json' }))
}
