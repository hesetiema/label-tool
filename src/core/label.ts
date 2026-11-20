/**
 * ============================================================
 * 标注结果序列化 —— 与 SUSTechPOINTS 格式互通
 * ============================================================
 *
 * 标注工具的价值一半在"标"，一半在"能导出成算法认识的格式"。
 * 这里实现我们的 Box3D <-> 原仓库 label JSON 的双向转换，
 * 这样你标的结果可以直接喂给原仓库、或用它已有的数据来学习。
 */
import type { Box3D } from './types'
import type { RawLabelObject } from './types'
import { boxToVertices } from './box'

/** 内部模型 → 原仓库 JSON 对象 */
export function toRawLabel(box: Box3D): RawLabelObject {
  return {
    psr: {
      position: { ...box.position },
      scale: { ...box.scale },
      // 原仓库 rotation 是 Euler 的 x/y/z；我们 MVP 只支持绕 z 的 yaw
      rotation: { x: 0, y: 0, z: box.yaw },
    },
    obj_type: box.label,
    obj_id: box.id,
    vertices: boxToVertices(box),
  }
}

/** 原仓库 JSON 对象 → 内部模型 */
export function fromRawLabel(raw: RawLabelObject): Box3D {
  return {
    id: String(raw.obj_id),
    label: raw.obj_type,
    position: { ...raw.psr.position },
    scale: { ...raw.psr.scale },
    yaw: raw.psr.rotation.z,
  }
}

/** 导出整帧标注为 JSON 字符串（可直接保存为 label/000970.json） */
export function serializeLabels(boxes: Box3D[]): string {
  return JSON.stringify(boxes.map(toRawLabel), null, 2)
}

/** 从 JSON 字符串解析出所有框 */
export function parseLabels(json: string): Box3D[] {
  const raws: RawLabelObject[] = JSON.parse(json)
  return raws.map(fromRawLabel)
}

/** 触发浏览器下载 JSON 文件 */
export function downloadJson(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
