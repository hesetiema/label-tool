/**
 * ============================================================
 * RTS 平滑（Rauch–Tung–Striebel 后向平滑）
 * ============================================================
 *
 * 【为什么需要它】
 *   关键帧之间的补间是"猜"的：Hermite 用端点速度，端点速度又是差分的。
 *   一旦关键帧本身有几个厘米的抖动（人工拖框、模型输出的呼吸感），
 *   中间帧会被放大成"车在路上抖一下"。RTS 用整条轨迹的信息回头修每一帧，
 *   比任何"逐段插值"都稳 —— 因为它知道后面怎么走。
 *
 * 【哪些关键帧不许动】
 *   人工标的帧是"事实"，算法没有资格挪动它 —— 所以 `locked: true` 或
 *   `source.kind === 'manual'` 的关键帧取极小噪声（硬观测），平滑后再强行写回原值。
 *   而模型/导入产生的关键帧（`source.kind === 'model' | 'import'`）本来就是
 *   "算出来的观测"，抖动正是要修的东西，按普通观测处理，允许被挪动几个厘米。
 *
 *   这条区分很关键：跟踪器导出的逐帧框几乎都有呼吸感（±5cm），
 *   如果所有关键帧都锁死，平滑就退化成"只能在两帧之间画曲线"，收益接近零。
 *
 * 【为什么只平滑位置】
 *   朝向是角度：±π 附近线性滤波会把 179° 和 -179° 平均成 0°（车头原地掉头）。
 *   要做也得先解缠（unwrap）再滤波再回缠，而朝向的抖动通常来自 yaw 标注本身，
 *   不是插值噪声。本版只平滑 x/y，z 也保留插值值（路面坡度是慢变量，不需要）。
 *
 * 【为什么失败要"整条放弃"而不是"部分平滑"】
 *   方案 6.2 的约束：偏移 > 0.3m 说明标注本身抖得离谱，此时平滑结果会
 *   把框挪到肉眼可见的错位置。提示用户去修标注，比给一条"看起来顺但位置错"
 *   的轨迹有用得多。
 */
import type { Track } from '../model/track'
import { sampleTrack, type SmoothPath } from '../store/materialize'
import type { SampleDocument } from '../model/document'
import type { TrackId } from '../model/ids'

export interface SmoothOptions {
  /** 位置过程噪声：越大越跟手、越小越平（默认 0.5，方案 6.2 给定） */
  q?: number
  /** 普通观测噪声（默认 1.0） */
  r?: number
  /** 关键帧的观测噪声：极小 = 硬观测（默认 1e-4） */
  lockedR?: number
  /** 允许的最大偏移（米）：超过就整条放弃（默认 0.3，方案 6.2 给定） */
  maxShift?: number
}

export type SmoothSkipReason = 'too-few-keyframes' | 'empty-sample' | 'shift-too-large'

export interface SmoothOutcome {
  path: SmoothPath | null
  /** path 为 null 时说明为什么放弃 */
  reason?: SmoothSkipReason
  /** 平滑前后最大位移（米）。放弃时也会填，用于提示"抖了多远" */
  maxShift: number
}

const DEFAULTS = { q: 0.5, r: 1.0, lockedR: 1e-4, maxShift: 0.3 }

/**
 * 1 维常速度模型的 RTS 平滑。
 *
 * 状态 `[p, v]`，`F = [[1,1],[0,1]]`（dt = 1 帧），`H = [1,0]`，
 * `Q = q·[[1/4,1/2],[1/2,1]]`（白噪声加速度模型离散化）。
 *
 * 手写 2×2 而不是引入矩阵库：这里只有 4 个数，加一个依赖不值得，
 * 而且 2×2 的逆有闭式解，比通用求逆快一个量级。
 */
function rts1d(z: Float64Array, r: Float64Array, q: number): Float64Array {
  const n = z.length
  // 滤波结果（后向平滑要用），以及每步的预测量/预测协方差
  const xf = new Float64Array(n)
  const vf = new Float64Array(n)
  const pf00 = new Float64Array(n)
  const pf01 = new Float64Array(n)
  const pf11 = new Float64Array(n)
  const xp = new Float64Array(n)
  const vp = new Float64Array(n)
  const pp00 = new Float64Array(n)
  const pp01 = new Float64Array(n)
  const pp11 = new Float64Array(n)

  // 初值：位置取首个观测，速度未知（给大方差，让前几帧自己收敛）
  let p = z[0]
  let v = 0
  let c00 = 100
  let c01 = 0
  let c11 = 100

  for (let t = 0; t < n; t++) {
    // ---- 预测 ----
    const pPred = p + v
    const vPred = v
    const n00 = c00 + 2 * c01 + c11 + q * 0.25
    const n01 = c01 + c11 + q * 0.5
    const n11 = c11 + q
    xp[t] = pPred
    vp[t] = vPred
    pp00[t] = n00
    pp01[t] = n01
    pp11[t] = n11

    // ---- 更新（标量观测） ----
    const s = n00 + r[t]
    const k0 = n00 / s
    const k1 = n01 / s
    const innov = z[t] - pPred
    p = pPred + k0 * innov
    v = vPred + k1 * innov
    c00 = (1 - k0) * n00
    c01 = (1 - k0) * n01
    c11 = n11 - k1 * n01
    xf[t] = p
    vf[t] = v
    pf00[t] = c00
    pf01[t] = c01
    pf11[t] = c11
  }

  // ---- 后向平滑 ----
  // 状态是 [位置, 速度]，两维都要回传：只回传位置相当于把速度差当 0，
  // 那样得到的不是 RTS，而是"带泄漏的低通"，拐弯处会明显滞后。
  const xsp = new Float64Array(n)
  const xsv = new Float64Array(n)
  xsp[n - 1] = xf[n - 1]
  xsv[n - 1] = vf[n - 1]
  for (let t = n - 2; t >= 0; t--) {
    // C = P_t|t · Fᵀ · P_{t+1|t}⁻¹
    // P·Fᵀ = [[c00+c01, c01], [c01+c11, c11]]
    const a = pf00[t] + pf01[t]
    const b = pf01[t]
    const c = pf01[t] + pf11[t]
    const d = pf11[t]
    const det = pp00[t + 1] * pp11[t + 1] - pp01[t + 1] * pp01[t + 1]
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
      // 奇异：这一步退回滤波值，不让数值问题污染整条轨迹
      xsp[t] = xf[t]
      xsv[t] = vf[t]
      continue
    }
    const i00 = pp11[t + 1] / det
    const i01 = -pp01[t + 1] / det
    const i11 = pp00[t + 1] / det
    const c00s = a * i00 + b * i01
    const c01s = a * i01 + b * i11
    const c10s = c * i00 + d * i01
    const c11s = c * i01 + d * i11
    const dp = xsp[t + 1] - xp[t + 1]
    const dv = xsv[t + 1] - vp[t + 1]
    xsp[t] = xf[t] + c00s * dp + c01s * dv
    xsv[t] = vf[t] + c10s * dp + c11s * dv
  }
  return xsp
}

/**
 * 平滑一条轨迹。返回可直接塞进 `MaterializeOptions.paths` 的路径。
 */
export function smoothTrack(track: Track, opts: SmoothOptions = {}): SmoothOutcome {
  const q = opts.q ?? DEFAULTS.q
  const r = opts.r ?? DEFAULTS.r
  const lockedR = opts.lockedR ?? DEFAULTS.lockedR
  const maxShift = opts.maxShift ?? DEFAULTS.maxShift

  const kfs = track.keyframes
  // 单点轨迹没有"轨迹"可言：平滑它只会把框挪离唯一的观测
  if (kfs.length < 2) return { path: null, reason: 'too-few-keyframes', maxShift: 0 }

  const from = track.lifecycle.first
  const to = track.lifecycle.last
  const n = to - from + 1
  if (n <= 0) return { path: null, reason: 'empty-sample', maxShift: 0 }

  // 基线 = 现有线性插值。平滑修的是它的抖动，而不是另起一套运动模型
  const zx = new Float64Array(n)
  const zy = new Float64Array(n)
  const rWeight = new Float64Array(n).fill(r)
  const pinned = new Map<number, { x: number; y: number }>()
  for (const kf of kfs) {
    const hard = kf.locked === true || kf.source?.kind === 'manual'
    // 人工帧：硬观测（R 极小）。模型/导入帧：普通观测，允许被平滑挪动
    if (hard) pinned.set(kf.frame, { x: kf.geometry.position.x, y: kf.geometry.position.y })
  }

  for (let i = 0; i < n; i++) {
    const f = from + i
    const sampled = sampleTrack(track, f, { mode: 'linear' })
    if (!sampled) return { path: null, reason: 'empty-sample', maxShift: 0 }
    zx[i] = sampled.geometry.position.x
    zy[i] = sampled.geometry.position.y
    if (pinned.has(f)) rWeight[i] = lockedR
  }

  const sx = rts1d(zx, rWeight, q)
  const sy = rts1d(zy, rWeight, q)

  let shift = 0
  for (let i = 0; i < n; i++) {
    const kf = pinned.get(from + i)
    if (kf) {
      // 硬约束：数值误差也不允许挪动人工标的框
      sx[i] = kf.x
      sy[i] = kf.y
      continue
    }
    shift = Math.max(shift, Math.hypot(sx[i] - zx[i], sy[i] - zy[i]))
  }

  if (shift > maxShift) {
    return { path: null, reason: 'shift-too-large', maxShift: shift }
  }

  const path: SmoothPath = {
    maxShift: shift,
    at(frame) {
      const i = frame - from
      if (i < 0 || i >= n) return null
      return { x: sx[i], y: sy[i] }
    },
  }
  return { path, maxShift: shift }
}

export interface DocumentSmoothResult {
  paths: Map<TrackId, SmoothPath>
  skipped: Array<{ id: TrackId; reason: SmoothSkipReason; maxShift: number }>
}

/** 对整份文档的 boxes 轨迹做一次平滑，产出可直接给物化用的路径表 */
export function smoothDocument(doc: SampleDocument, opts: SmoothOptions = {}): DocumentSmoothResult {
  const paths = new Map<TrackId, SmoothPath>()
  const skipped: DocumentSmoothResult['skipped'] = []
  for (const track of doc.tasks.boxes.tracks) {
    const out = smoothTrack(track, opts)
    if (out.path) paths.set(track.id, out.path)
    else skipped.push({ id: track.id, reason: out.reason ?? 'empty-sample', maxShift: out.maxShift })
  }
  return { paths, skipped }
}
