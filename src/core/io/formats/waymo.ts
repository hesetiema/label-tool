/**
 * Waymo Open Dataset 适配器。
 *
 * Waymo 原始格式是 TFRecord + Protobuf，浏览器里没法直接读；
 * 实际使用通常是官方工具导出成 JSON，例如：
 *   { objects: [ { box: { center:{x,y,z}, size:{length,width,height}, heading },
 *                  type: 'VEHICLE', id: '...' } ] }
 * 或者 mmdet3d / 各家中转格式：
 *   [ { location:[x,y,z], dimensions:[l,w,h], heading, label } ]
 *
 * 本适配器同时接受这两种形态。Waymo vehicle 系是 x 前、y 左、z 上，
 * heading 从 +x 起算绕 z，与内部约定基本一致，转换最轻。
 */
import type { Box3D } from '../../types'
import { defaultNameMap, mapName, parseNumber, skippedAdd } from './utils'
import { waymoHeadingToYaw } from './conventions'
import type { FormatAdapter, FormatParseResult, ParseOptions, SkippedInfo } from './types'

const WAYMO_NAMES = defaultNameMap({
  TYPE_VEHICLE: 'Car', TYPE_PEDESTRIAN: 'Pedestrian', TYPE_CYCLIST: 'Cyclist',
  TYPE_SIGN: 'TrafficSign', VEHICLE: 'Car', PEDESTRIAN: 'Pedestrian',
  CYCLIST: 'Cyclist', SIGN: 'TrafficSign', Car: 'Car', Pedestrian: 'Pedestrian',
  Cyclist: 'Cyclist',
})

interface WaymoObject {
  type?: string
  label?: string
  id?: string | number
  track_id?: string | number
  heading?: number
  yaw?: number
  score?: number
  box?: {
    center?: { x?: number; y?: number; z?: number } | number[]
    size?: { length?: number; width?: number; height?: number } | number[]
    heading?: number
  }
  center?: { x?: number; y?: number; z?: number } | number[]
  size?: { length?: number; width?: number; height?: number } | number[]
  location?: number[]
  dimensions?: number[]
}

function vec3(v: WaymoObject['center']): [number, number, number] | null {
  if (!v) return null
  if (Array.isArray(v)) return [v[0], v[1], v[2]]
  return [v.x ?? NaN, v.y ?? NaN, v.z ?? NaN]
}

function size3(v: WaymoObject['size']): [number, number, number] | null {
  if (!v) return null
  if (Array.isArray(v)) return [v[0], v[1], v[2]] // 约定 (l,w,h)
  return [v.length ?? NaN, v.width ?? NaN, v.height ?? NaN]
}

function toArray(raw: unknown): WaymoObject[] | null {
  if (Array.isArray(raw)) return raw as WaymoObject[]
  if (raw && typeof raw === 'object') {
    const o = raw as { objects?: WaymoObject[]; labels?: WaymoObject[]; detections?: WaymoObject[] }
    return o.objects ?? o.labels ?? o.detections ?? null
  }
  return null
}

export const waymoAdapter: FormatAdapter = {
  id: 'waymo',
  label: 'Waymo Open (JSON 导出)',

  detect(raw: unknown, filename?: string) {
    let data: unknown = raw
    if (typeof raw === 'string') {
      if (!/^\[|^\{/.test(raw.trim())) return 0
      try { data = JSON.parse(raw) } catch { return 0 }
    }
    const arr = toArray(data)
    if (!arr?.length) return 0
    const first = arr[0]
    if (!first || typeof first !== 'object') return 0
    const hasBox = !!first.box && !!size3(first.box.size)
    const hasFlat = !!size3(first.size) || (Array.isArray(first.dimensions) && first.dimensions.length >= 3)
    const hasType = typeof first.type === 'string' || typeof first.label === 'string'
    if ((hasBox || hasFlat) && hasType) return 1
    return filename && /waymo/i.test(filename) ? 0.3 : 0
  },

  parse(raw: unknown, options?: ParseOptions): FormatParseResult {
    let data: unknown = raw
    if (typeof raw === 'string') {
      try { data = JSON.parse(raw) } catch { throw new Error('Waymo 标注不是合法 JSON') }
    }
    const arr = toArray(data)
    if (!arr) throw new Error('Waymo 标注应为对象数组或含 objects 的对象')

    const boxes: Box3D[] = []
    const skipped: SkippedInfo[] = []
    let autoId = 0

    for (const o of arr) {
      const center = vec3(o.box?.center ?? o.center)
      const size = size3(o.box?.size ?? o.size)
        ?? (Array.isArray(o.dimensions) ? [o.dimensions[0], o.dimensions[1], o.dimensions[2]] : null)
      const location = Array.isArray(o.location) ? o.location : null
      const pos = center ?? (location ? [location[0], location[1], location[2]] as [number, number, number] : null)
      if (!pos || !size) { skippedAdd(skipped, '缺少 box.center/size'); continue }

      const rawName = String(o.type ?? o.label ?? '')
      const label = mapName(rawName, WAYMO_NAMES, options?.nameMap)
      if (!label || label === '__skip__') { skippedAdd(skipped, `类别 ${rawName || '?'}`); continue }

      const headingRaw = o.box?.heading ?? o.heading ?? o.yaw ?? 0
      const [x, y, z] = pos.map((v) => parseNumber(v, 'center'))
      const [l, w, h] = size.map((v) => parseNumber(v, 'size'))

      boxes.push({
        id: String(o.id ?? o.track_id ?? ++autoId),
        label,
        position: { x, y, z },
        scale: { x: l, y: w, z: h },
        yaw: waymoHeadingToYaw(parseNumber(headingRaw, 'heading'), options?.flipYaw),
        attributes: { score: o.score ?? 1 },
      })
    }
    if (!boxes.length) throw new Error('没有解析到有效 Waymo 标注')
    return {
      boxes,
      skipped,
      convention: 'Waymo vehicle 系 z-up · (l,w,h) 直译 · heading 从 +x 起算（可 flipYaw）',
    }
  },
}
