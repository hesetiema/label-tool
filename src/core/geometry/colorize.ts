/**
 * ============================================================
 * 标量着色 —— 把强度 / 高度映射成颜色
 * ============================================================
 *
 * 点云标注工具里"能看出结构"比"颜色好看"重要得多：
 *   - 按**强度**着色能区分路面（低反射）与车道线、路牌、车漆（高反射）
 *   - 按**高度**着色是判断坡道、台阶、悬空物体的最快方式
 * 这两件事在 CVAT / Supervisely / SUSTechPOINTS 里都是默认能力，
 * 而默认的统一冷灰会把它们全糊在一起。
 *
 * 【为什么要用分位数而不是 min/max】
 *   真实点云里常有极少数离群点（远处的噪点、反射率 65535 的坏值）。
 *   直接按 min/max 归一化，99.9% 的点会被挤到色带最左端的一小段里，
 *   看起来还是"一片同色"。取 2%~98% 分位并把两侧截断，主体才有层次。
 *   分位数靠**抽样**估计（最多 2 万个样本），1M 点的排序开销被压到可忽略。
 *
 * 【为什么输出 Float32Array 而不是 Uint8】
 *   three.js 的 `vertexColors` 与 OrthoView 的 ImageData 都接受 0~1 浮点，
 *   直接给浮点省一次除法，也与 PCD 自带颜色的量纲一致。
 */
import type { PointCloud } from '../types'

export type RampName = 'turbo' | 'viridis'

/** 色带控制点：[位置 0~1, r, g, b]（0~1） */
type RampStop = readonly [number, number, number, number]

const RAMPS: Record<RampName, readonly RampStop[]> = {
  // 近似 turbo：蓝 → 青 → 绿 → 黄 → 红，亮度单调，边界清楚
  turbo: [
    [0, 0.19, 0.07, 0.35],
    [0.2, 0.09, 0.42, 0.78],
    [0.4, 0.12, 0.78, 0.65],
    [0.6, 0.55, 0.94, 0.31],
    [0.8, 0.98, 0.68, 0.15],
    [1, 0.83, 0.13, 0.09],
  ],
  // viridis：暗紫 → 蓝绿 → 亮黄，感知均匀，适合打印/投影
  viridis: [
    [0, 0.27, 0.0, 0.33],
    [0.25, 0.23, 0.32, 0.55],
    [0.5, 0.13, 0.55, 0.55],
    [0.75, 0.37, 0.79, 0.38],
    [1, 0.99, 0.91, 0.14],
  ],
}

export interface ColorizeOptions {
  /** 指定下界；不传则用 2% 分位 */
  min?: number
  max?: number
  ramp?: RampName
  /** 分位截断比例（0.02 = 两端各截 2%），传 0 表示用真实 min/max */
  trim?: number
}

/** 抽样估计标量的主体范围（2%~98% 分位），用于避免离群点压平色带 */
export function scalarRange(values: Float32Array, trim = 0.02): { min: number; max: number } {
  const n = values.length
  if (n === 0) return { min: 0, max: 1 }
  const sampleLimit = 20000
  const step = Math.max(1, Math.floor(n / sampleLimit))
  const sample: number[] = []
  for (let i = 0; i < n; i += step) {
    const v = values[i]
    if (Number.isFinite(v)) sample.push(v)
  }
  if (sample.length === 0) return { min: 0, max: 1 }
  sample.sort((a, b) => a - b)
  const lo = sample[Math.floor(sample.length * trim)] ?? sample[0]
  const hi = sample[Math.min(sample.length - 1, Math.ceil(sample.length * (1 - trim)) - 1)] ?? sample[sample.length - 1]
  return hi > lo ? { min: lo, max: hi } : { min: lo, max: lo + 1 }
}

/** 把一个 0~1 的 t 按色带取色 */
export function rampColor(t: number, ramp: RampName = 'turbo'): [number, number, number] {
  const stops = RAMPS[ramp]
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  for (let i = 1; i < stops.length; i++) {
    const [p1, r1, g1, b1] = stops[i]
    if (x > p1) continue
    const [p0, r0, g0, b0] = stops[i - 1]
    const k = p1 === p0 ? 0 : (x - p0) / (p1 - p0)
    return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k]
  }
  return [stops[stops.length - 1][1], stops[stops.length - 1][2], stops[stops.length - 1][3]]
}

/**
 * 标量数组 → 每点 rgb（长度 = values.length * 3）。
 * 非有限值按色带最左端处理（与"无效点"视觉一致，不会跳成刺眼的颜色）。
 */
export function scalarColors(values: Float32Array, opts: ColorizeOptions = {}): Float32Array {
  const ramp = opts.ramp ?? 'turbo'
  const range = scalarRange(values, opts.trim ?? 0.02)
  const min = opts.min ?? range.min
  const max = opts.max ?? range.max
  const span = max - min || 1
  const out = new Float32Array(values.length * 3)
  for (let i = 0; i < values.length; i++) {
    const [r, g, b] = rampColor((values[i] - min) / span, ramp)
    out[i * 3] = r
    out[i * 3 + 1] = g
    out[i * 3 + 2] = b
  }
  return out
}

/** 取出每个点的高度（本项目约定数据是 z-up，与相机 `up = (0,0,1)` 一致） */
export function heightsOf(positions: Float32Array): Float32Array {
  const count = Math.floor(positions.length / 3)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = positions[i * 3 + 2]
  return out
}

/**
 * 按当前模式取点云颜色；返回 undefined 表示"用默认冷灰"。
 * 3D 视口与正交视图共用这一处判定，避免两边对"强度模式"的理解不一致。
 */
export function cloudColorsFor(
  cloud: PointCloud,
  mode: 'default' | 'semantic' | 'intensity' | 'height',
): Float32Array | undefined {
  if (mode === 'semantic') {
    // 语义色由调用方提供类别表（core 不该认识 domain 的类别配置），这里只管强度/高度
    return undefined
  }
  if (mode === 'intensity' && cloud.intensity?.length) {
    return scalarColors(cloud.intensity, { ramp: 'turbo' })
  }
  if (mode === 'height') {
    return scalarColors(heightsOf(cloud.positions), { ramp: 'viridis' })
  }
  return undefined
}
