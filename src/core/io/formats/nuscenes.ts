/**
 * nuScenes 适配器 —— 关系型 JSON 的代表。
 *
 * nuScenes 不像 KITTI 那样一帧一个文件，而是"多张表 + token 外键"：
 *   annotations.json     sample_annotation: translation / size / rotation / instance_token
 *   instances.json       instance: category_token
 *   categories.json      category: name
 *   samples.json         sample: token（按帧筛选用）
 *
 * 本适配器接受三种输入（自动识别）：
 *  1) 完整的 sample_annotation 数组 + options.categoryTokens（由调用方从 categories 表构造）
 *  2) 对象 { annotations, instances?, categories?, sampleToken? }，内部自己串 token
 *  3) 单帧标注数组（每项直接带 category_name）
 *
 * size 顺序是 (width, length, height)，与内部 (length, width, height) 不同；
 * rotation 是四元数 (w,x,y,z)，不是 yaw。
 */
import type { Box3D } from '../../types'
import { defaultNameMap, mapName, parseNumber, skippedAdd } from './utils'
import { quaternionToYaw } from './conventions'
import type { FormatAdapter, FormatParseResult, ParseOptions, SkippedInfo } from './types'

const NUS_NAMES = defaultNameMap({
  'vehicle.car': 'Car',
  'vehicle.truck': 'Truck',
  'vehicle.bus.rigid': 'Bus',
  'vehicle.bus.bendy': 'Bus',
  'vehicle.van': 'Van',
  'vehicle.construction': 'Truck',
  'vehicle.trailer': 'Truck',
  'human.pedestrian.adult': 'Pedestrian',
  'human.pedestrian.child': 'Pedestrian',
  'human.pedestrian.construction_worker': 'Pedestrian',
  'human.pedestrian.police_officer': 'Pedestrian',
  'human.pedestrian.stroller': 'Other',
  'vehicle.bicycle': 'Cyclist',
  'vehicle.motorcycle': 'Rider',
  'movable_object.trafficcone': 'TrafficCone',
  'static_object.bicycle_rack': 'Other',
})

interface NusAnn {
  token?: string
  sample_token?: string
  instance_token?: string
  category_token?: string
  category_name?: string
  translation?: number[]
  size?: number[]
  rotation?: number[]
  visibility_token?: string
  attribute_tokens?: string[]
  num_lidar_pts?: number
}

interface NusPayload {
  annotations?: NusAnn[]
  sample_annotation?: NusAnn[]
  instances?: { token: string; category_token: string }[]
  categories?: { token: string; name: string }[]
  sampleToken?: string
}

function toArray(raw: unknown): NusAnn[] | null {
  if (Array.isArray(raw)) return raw as NusAnn[]
  if (raw && typeof raw === 'object') {
    const p = raw as NusPayload
    const anns = p.annotations ?? p.sample_annotation
    if (Array.isArray(anns)) return anns
  }
  return null
}

function looksLikeNus(a: NusAnn): boolean {
  return (
    Array.isArray(a?.translation) &&
    a.translation.length >= 3 &&
    Array.isArray(a?.size) &&
    a.size.length >= 3 &&
    (Array.isArray(a?.rotation) || !!a?.category_name || !!a?.instance_token)
  )
}

export const nuscenesAdapter: FormatAdapter = {
  id: 'nuscenes',
  label: 'nuScenes (关系型 JSON)',

  detect(raw: unknown, filename?: string) {
    let data: unknown = raw
    if (typeof raw === 'string') {
      if (!/^\[|^\{/.test(raw.trim())) return 0
      try {
        data = JSON.parse(raw)
      } catch {
        return 0
      }
    }
    const arr = toArray(data)
    if (arr && arr.length) return looksLikeNus(arr[0]) ? 1 : 0
    if (data && typeof data === 'object') {
      const p = data as NusPayload
      if (Array.isArray(p.sample_annotation)) return 0.9
    }
    return filename && /nusc|sample_annotation/i.test(filename) ? 0.3 : 0
  },

  parse(raw: unknown, options?: ParseOptions): FormatParseResult {
    let data: unknown = raw
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw)
      } catch {
        throw new Error('nuScenes 标注不是合法 JSON')
      }
    }
    const anns = toArray(data)
    if (!anns) throw new Error('nuScenes 标注应是 sample_annotation 数组或含 annotations 的对象')

    // 构造 instance_token → 类别名 的查找表
    const payload = (data && !Array.isArray(data) ? data : {}) as NusPayload
    const catByToken = new Map<string, string>()
    for (const [k, v] of Object.entries(options?.categoryTokens ?? {})) catByToken.set(k, v)
    for (const c of payload.categories ?? []) catByToken.set(c.token, NUS_NAMES[c.name] ?? c.name)
    const instToCat = new Map<string, string>()
    for (const inst of payload.instances ?? []) {
      instToCat.set(inst.token, catByToken.get(inst.category_token) ?? inst.category_token)
    }

    const boxes: Box3D[] = []
    const skipped: SkippedInfo[] = []
    const sampleFilter = options?.sampleToken ?? payload.sampleToken
    let id = 0

    for (const a of anns) {
      if (sampleFilter && a.sample_token && a.sample_token !== sampleFilter) continue
      if (!a.translation || !a.size || !a.rotation) {
        skippedAdd(skipped, '缺少 translation/size/rotation')
        continue
      }
      const rawName =
        a.category_name ??
        (a.instance_token ? instToCat.get(a.instance_token) : undefined) ??
        (a.category_token ? catByToken.get(a.category_token) : undefined) ??
        'Car'
      const label = mapName(rawName, NUS_NAMES, options?.nameMap)
      if (!label || label === '__skip__') {
        skippedAdd(skipped, `类别 ${rawName}`)
        continue
      }

      const [w, l, h] = a.size.map((v) => parseNumber(v, 'size'))
      const [x, y, z] = a.translation.map((v) => parseNumber(v, 'translation'))
      const yaw = quaternionToYaw(a.rotation.map((v) => parseNumber(v, 'rotation')))

      boxes.push({
        id: a.instance_token ?? String(++id),
        label,
        position: { x, y, z },
        // nuScenes size = (width, length, height) → 内部 (l, w, h)
        scale: { x: l, y: w, z: h },
        yaw,
        attributes: {
          visibility: a.visibility_token ?? '',
          numLidarPts: a.num_lidar_pts ?? 0,
        },
      })
    }
    if (!boxes.length) throw new Error('没有解析到有效 nuScenes 标注')
    return {
      boxes,
      skipped,
      convention: 'nuScenes 全局/自车系 z-up · size(w,l,h)→(l,w,h) · 四元数→yaw',
    }
  },
}
