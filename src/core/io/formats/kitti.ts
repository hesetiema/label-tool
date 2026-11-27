/**
 * KITTI 风格适配器 —— 同时覆盖两种"长得像 KITTI"的数据：
 *
 *  A) 经典 KITTI label_2/*.txt：每行一个目标，空格分隔 15 个字段，
 *     location 在相机系，尺寸顺序 (h, w, l)，朝向是绕相机 y 轴的 ry。
 *  B) DAIR-V2X 单侧标注 JSON：字段是 KITTI 命名但坐标系是 LiDAR 系，
 *     rotation 从 +y 轴起算。官网明确写了"3D 标注采用 LiDAR 坐标系"。
 *
 * 两者差别足够大，用两个独立适配器实现，而不是在一个函数里塞 if。
 */
import type { Box3D } from '../../types'
import { defaultNameMap, mapName, parseNumber, skippedAdd } from './utils'
import { dairRotationToYaw, hwlToLwh, kittiCameraToLidar, kittiRyToYaw, normalizeAngle } from './conventions'
import type { FormatAdapter, FormatParseResult, ParseOptions, SkippedInfo } from './types'

/** KITTI 常见类别；DontCare 一律跳过（它是"不要评估此区域"的标记，不是目标） */
const KITTI_NAMES: Record<string, string> = defaultNameMap({
  Car: 'Car',
  Van: 'Van',
  Truck: 'Truck',
  Pedestrian: 'Pedestrian',
  Person_sitting: 'Pedestrian',
  Cyclist: 'Cyclist',
  Tram: 'Truck',
  Misc: 'Other',
  DontCare: '__skip__',
})

/**
 * KITTI 文本行的字段位置（0-based）：
 *  0 type | 1 truncated | 2 occluded | 3 alpha | 4-7 bbox2d
 *  8 h | 9 w | 10 l | 11 x | 12 y | 13 z | 14 ry | 15 score(可选)
 */
export const kittiAdapter: FormatAdapter = {
  id: 'kitti',
  label: 'KITTI label_2 (.txt)',

  detect(raw: unknown, filename?: string) {
    if (typeof raw !== 'string') return 0
    const first = raw.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'))
    if (!first) return 0
    const parts = first.trim().split(/\s+/)
    // 至少 15 段，且 8~14 必须是数字——这是 KITTI 行最稳的特征
    const numeric = parts.slice(8, 15).every((p) => Number.isFinite(Number(p)))
    if (parts.length >= 15 && numeric) return 1
    return filename && /\.txt$/i.test(filename) && parts.length >= 14 ? 0.35 : 0
  },

  parse(raw: unknown, options?: ParseOptions): FormatParseResult {
    if (typeof raw !== 'string') throw new Error('KITTI 标注应为文本')
    const boxes: Box3D[] = []
    const skipped: SkippedInfo[] = []
    let id = 0
    const frame = options?.frame ?? 'camera'

    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const p = t.split(/\s+/)
      if (p.length < 15) continue
      const label = mapName(p[0], KITTI_NAMES, options?.nameMap)
      if (label === '__skip__') {
        skippedAdd(skipped, `类别 ${p[0]}`)
        continue
      }

      const h = parseNumber(p[8], 'h')
      const w = parseNumber(p[9], 'w')
      const l = parseNumber(p[10], 'l')
      const cx = parseNumber(p[11], 'x')
      const cy = parseNumber(p[12], 'y')
      const cz = parseNumber(p[13], 'z')
      const ry = parseNumber(p[14], 'ry')

      const pos = frame === 'lidar' ? { x: cx, y: cy, z: cz } : kittiCameraToLidar(cx, cy, cz)
      const yaw = frame === 'lidar' ? normalizeAngle(ry) : kittiRyToYaw(ry, options?.flipYaw)

      boxes.push({
        id: String(++id),
        label,
        position: pos,
        scale: { x: l, y: w, z: h },
        yaw,
        attributes: {
          truncated: parseNumber(p[1], 'truncated'),
          occluded: parseNumber(p[2], 'occluded'),
          alpha: parseNumber(p[3], 'alpha'),
        },
      })
    }
    // 全是 DontCare 时返回空框数组 + 跳过统计，而不是报错（这是合法情况）
    return {
      boxes,
      skipped,
      convention:
        frame === 'camera'
          ? 'KITTI 相机系 → LiDAR 自车系；ry → yaw = -ry-π/2（可 flipYaw 翻转）'
          : 'KITTI 文本但 location 已在 LiDAR 系（frame=lidar）',
    }
  },

  serialize(boxes: Box3D[]) {
    return boxes
      .map((b) => {
        // 内部 → 相机系的逆变换：x_cam=-y, y_cam=-z, z_cam=x
        const xCam = -b.position.y
        const yCam = -b.position.z
        const zCam = b.position.x
        const ry = normalizeAngle(-b.yaw - Math.PI / 2)
        return [
          b.label,
          '0.00',
          '0',
          '-1.00',
          '0',
          '0',
          '0',
          '0',
          b.scale.z.toFixed(2),
          b.scale.y.toFixed(2),
          b.scale.x.toFixed(2),
          xCam.toFixed(2),
          yCam.toFixed(2),
          zCam.toFixed(2),
          ry.toFixed(2),
        ].join(' ')
      })
      .join('\n')
  },
}

/** DAIR-V2X 单帧标注里的一个目标（新版字段：3d_dimensions / 3d_location / rotation） */
interface DairObject {
  type?: string
  truncated_state?: number
  occluded_state?: number
  alpha?: number
  '3d_dimensions'?: { h?: number; w?: number; l?: number }
  '3d_location'?: { x?: number; y?: number; z?: number }
  rotation?: number
  // 旧版 / 类 KITTI 字段兼容
  dimensions?: number[] | { h?: number; w?: number; l?: number }
  location?: number[] | { x?: number; y?: number; z?: number }
  rotation_y?: number
}

const DAIR_NAMES = defaultNameMap({
  Car: 'Car',
  Trunk: 'Truck',
  Truck: 'Truck',
  Van: 'Van',
  Bus: 'Bus',
  Pedestrian: 'Pedestrian',
  Cyclist: 'Cyclist',
  Tricyclist: 'Cyclist',
  Motorcyclist: 'Rider',
  Barrowlist: 'Other',
  TrafficCone: 'TrafficCone',
})

function dairFields(o: DairObject) {
  const dim = o['3d_dimensions'] ?? o.dimensions
  const loc = o['3d_location'] ?? o.location
  const arrDim = Array.isArray(dim) ? dim : undefined
  const arrLoc = Array.isArray(loc) ? loc : undefined
  const objDim = dim && !Array.isArray(dim) ? dim : undefined
  const objLoc = loc && !Array.isArray(loc) ? loc : undefined
  return {
    h: arrDim ? arrDim[0] : objDim?.h,
    w: arrDim ? arrDim[1] : objDim?.w,
    l: arrDim ? arrDim[2] : objDim?.l,
    x: arrLoc ? arrLoc[0] : objLoc?.x,
    y: arrLoc ? arrLoc[1] : objLoc?.y,
    z: arrLoc ? arrLoc[2] : objLoc?.z,
    rotation: o.rotation ?? o.rotation_y,
  }
}

export const dairAdapter: FormatAdapter = {
  id: 'dair-v2x',
  label: 'DAIR-V2X (JSON)',

  detect(raw: unknown, filename?: string) {
    let arr: unknown = raw
    if (typeof raw === 'string') {
      if (!raw.trim().startsWith('[')) return 0
      try {
        arr = JSON.parse(raw)
      } catch {
        return 0
      }
    }
    if (!Array.isArray(arr) || !arr.length) return 0
    const first = arr[0] as DairObject
    if (!first || typeof first !== 'object') return 0
    const f = dairFields(first)
    const hasDim = f.h !== undefined && f.w !== undefined && f.l !== undefined
    const hasLoc = f.x !== undefined && f.y !== undefined && f.z !== undefined
    if (hasDim && hasLoc && typeof first.type === 'string') return 1
    return filename && /dair|cooperative/i.test(filename) ? 0.3 : 0
  },

  parse(raw: unknown, options?: ParseOptions): FormatParseResult {
    let arr: unknown = raw
    if (typeof raw === 'string') {
      try {
        arr = JSON.parse(raw)
      } catch {
        throw new Error('DAIR-V2X 标注不是合法 JSON')
      }
    }
    if (!Array.isArray(arr)) throw new Error('DAIR-V2X 标注应为对象数组')
    const boxes: Box3D[] = []
    const skipped: SkippedInfo[] = []
    let id = 0

    for (const item of arr as DairObject[]) {
      const f = dairFields(item)
      const label = mapName(item.type ?? '', DAIR_NAMES, options?.nameMap)
      if (!label || label === '__skip__') {
        skippedAdd(skipped, `类别 ${item.type ?? '?'}`)
        continue
      }
      if (
        f.h === undefined ||
        f.w === undefined ||
        f.l === undefined ||
        f.x === undefined ||
        f.y === undefined ||
        f.z === undefined
      ) {
        skippedAdd(skipped, '缺少 3D 框字段')
        continue
      }
      const [L, W, H] = hwlToLwh(f.h, f.w, f.l)
      boxes.push({
        id: String(++id),
        label,
        position: { x: f.x, y: f.y, z: f.z },
        scale: { x: L, y: W, z: H },
        // rotation 在 LiDAR 系、从 +y 起算；转内部 yaw 要减 π/2
        yaw: dairRotationToYaw(f.rotation ?? 0, options?.flipYaw),
        attributes: {
          truncated: item.truncated_state ?? 0,
          occluded: item.occluded_state ?? 0,
          alpha: item.alpha ?? 0,
        },
      })
    }
    if (!boxes.length) throw new Error('没有解析到有效 DAIR-V2X 标注')
    return {
      boxes,
      skipped,
      convention: 'DAIR-V2X LiDAR 系 · z-up · rotation(+y 起算) → yaw = rotation-π/2',
    }
  },

  serialize(boxes: Box3D[]) {
    return JSON.stringify(
      boxes.map((b, i) => ({
        type: b.label,
        truncated_state: 0,
        occluded_state: b.visibility === 'occluded' ? 1 : 0,
        alpha: 0,
        '3d_dimensions': { h: b.scale.z, w: b.scale.y, l: b.scale.x },
        '3d_location': { x: b.position.x, y: b.position.y, z: b.position.z },
        rotation: normalizeAngle(b.yaw + Math.PI / 2),
        obj_id: i + 1,
      })),
      null,
      2,
    )
  },
}
