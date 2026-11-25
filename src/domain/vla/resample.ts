/**
 * ============================================================
 * 动作通道的重采样与统计
 * ============================================================
 *
 * 【为什么需要重采样】
 *   动作信号按自己传感器的频率采（20Hz / 50Hz），标注按帧走（10Hz）。
 *   两者不换算就直接逐帧对齐，等于把"第 3 帧"配到"第 15 个采样点"，
 *   曲线形状还是对的，时间全错 —— 而且错得很隐蔽，看图看不出来。
 *
 * 【为什么用线性插值而不是重采样滤波器】
 *   控制量在这里的用途是"和指令对得上"，不是拿去复现控制精度。
 *   线性插值不引入相位延迟，规则判定用（均值/符号/滞后）完全够用。
 *   真要训练用时，原始高频数据才是源头，不该从标注工具里取。
 */

/** 线性重采样：把 fromHz 下的等间隔序列换到 toHz。返回长度按 toHz/fromHz 比例伸缩 */
export function resampleLinear(values: readonly number[], fromHz: number, toHz: number): number[] {
  if (!values.length) return []
  if (!(fromHz > 0) || !(toHz > 0) || fromHz === toHz) return [...values]
  const ratio = toHz / fromHz
  const n = Math.max(1, Math.round(values.length * ratio))
  if (n === 1) return [values[0]]
  const out = new Array<number>(n)
  const step = (values.length - 1) / (n - 1)
  for (let i = 0; i < n; i++) {
    const pos = i * step
    const lo = Math.floor(pos)
    const hi = Math.min(values.length - 1, lo + 1)
    const t = pos - lo
    out[i] = values[lo] * (1 - t) + values[hi] * t
  }
  return out
}

/**
 * 指数平滑（一阶低通）。
 * alpha 越小越平；0.2 大约能在 10Hz 下去掉逐帧抖动而保留转向趋势。
 */
export function smoothExponential(values: readonly number[], alpha = 0.2): number[] {
  if (values.length <= 1) return [...values]
  const a = Math.min(0.99, Math.max(0.01, alpha))
  const out = new Array<number>(values.length)
  out[0] = values[0]
  for (let i = 1; i < values.length; i++) out[i] = out[i - 1] + a * (values[i] - out[i - 1])
  return out
}

/** 分位数。用线性插值，p ∈ [0,1]；空数组返回 0 */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const pos = Math.min(1, Math.max(0, p)) * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(sorted.length - 1, lo + 1)
  return sorted[lo] * (1 - (pos - lo)) + sorted[hi] * (pos - lo)
}

/** 均值；空数组返回 0（调用方自己判断"有没有数据"，不要用 0 当哨兵） */
export function mean(values: readonly number[]): number {
  if (!values.length) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/**
 * 二阶差分的绝对值序列。
 *
 * 这是"抖动"的代理指标：平滑曲线二阶差分接近 0，锯齿会显著放大。
 * 它**不是物理意义上的 jerk**（真正的 jerk 要除以 dt³），
 * 所以阈值必须和采样率绑在一起看 —— 见 `validateVla` 里的 hz 门禁。
 */
export function secondDifference(values: readonly number[]): number[] {
  if (values.length < 3) return []
  const out = new Array<number>(values.length - 2)
  for (let i = 1; i < values.length - 1; i++) {
    out[i - 1] = Math.abs(values[i + 1] - 2 * values[i] + values[i - 1])
  }
  return out
}

/** `values` 中第一个偏离 baseline 超过 eps 的下标；没有返回 -1 */
export function firstDeviation(values: readonly number[], baseline = 0, eps = 0.05): number {
  for (let i = 0; i < values.length; i++) {
    if (Math.abs(values[i] - baseline) > eps) return i
  }
  return -1
}

/**
 * 归一到 [0,1] 用于绘制。
 *
 * 【为什么按通道各自归一】
 *   四个通道单位不同（norm / m/s），共用一根纵轴的话 throttle 会把 speed 压成直线。
 *   所以只比形状不比幅度 —— 这也是这类曲线图唯一诚实的画法。
 *   常量通道返回 0.5（画在中线），不要返回 0（会贴着底边，看起来像"该通道一直是 0"）。
 */
export function normalize01(values: readonly number[]): number[] {
  if (!values.length) return []
  let lo = values[0]
  let hi = values[0]
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const range = hi - lo
  if (range < 1e-9) return values.map(() => 0.5)
  return values.map((v) => (v - lo) / range)
}
