/**
 * ============================================================
 * 光流 / 场景流：能算的算，不能算的不假装
 * ============================================================
 *
 * 三条口径（方案 5.3.3）：
 *   1. 轨迹框内的点：刚体变换 `p' = R(Δyaw)(p - c) + c + Δc`。
 *      精度取决于框，通常 < 0.05m；**不落盘**，导出时按需生成。
 *   2. 静态背景点：只落盘自车变换 `(dx, dy, dyaw, rmse)`，4 个数/帧。
 *   3. 动态非目标点：无法可靠估计，标 unknown，不参与训练。
 *
 * 【为什么第 2 条要用估计而不是直接用位姿】
 *   公开数据集大多给位姿，但自采数据经常只有点云。没有位姿时"静态背景怎么动的"
 *   就无从得知 —— 而静态点占一帧的 90% 以上，缺了它光流只剩目标那一小块。
 *   所以做地面带配准：地面点一定静止，用它反推自车运动。
 *
 * 【与方案的一处偏差：RANSAC → 相关匹配】
 *   方案 5.3.3 写的是"随机采样 3 对点 → SVD"。这在有对应关系时成立，
 *   而两帧点云之间**没有**对应关系 —— 先配对应再 RANSAC 就是 ICP，
 *   初值不好时会收敛到错的极小值，而且在 JS 里不可控。
 *   这里改成在地面带的 BEV 占据上做粗到细的刚体搜索：自车两帧间的位移
 *   本来就小（±3m / ±0.2rad），搜索空间有限，结果是确定性的、可复现的，
 *   也不需要在测试里固定随机种子。代价是搜索范围外的运动估不出来 ——
 *   所以返回值带 `inliers` 与 `rmse`，让调用方判断"这次估得靠不靠谱"。
 */
import type { BoxGeometryLike, Vec3 } from '../model/geometry'
import { angleDelta } from '../model/geometry'

/**
 * 约定：`(dx, dy, dyaw)` 是**把 a 帧坐标映射到 b 帧坐标**的刚体变换
 *   `p_b ≈ R(dyaw) · p_a + (dx, dy)`
 * 这个方向与 `rigidFlow`、`applyEgoMotion`、`score` 完全一致，
 * 不存在"这里正着转、那里反着转"的隐患。
 * 物理含义：无位姿时 b 就是自车当前帧，于是 `-(dx, dy)` 是自车位移在上一帧自车系下的表达。
 */
export interface EgoMotion {
  dx: number
  dy: number
  dyaw: number
  /** 内点数（地面带采样点中，变换后能落到目标点 tolerance 内的） */
  inliers: number
  /** 内点平均残差（米）。> 0.2 时调用方应提示"自车运动不可靠" */
  rmse: number
  /** 参与估计的地面带采样点数。太少时这个估计没有意义 */
  samples: number
}

export interface CloudLike {
  positions: Float32Array
  count: number
}

/**
 * 框内点的刚体流：把 `from` 位姿下采集的点搬到 `to` 位姿。
 *
 * 公式写成"绕 from 中心转、再平移到 to 中心"而不是"先平移后旋转"：
 * 后者会把目标绕世界原点甩一圈，车在 40m 外时误差是米级的。
 */
export function rigidFlow(
  points: Float32Array,
  indices: ArrayLike<number>,
  from: BoxGeometryLike,
  to: BoxGeometryLike,
  out: Float32Array,
  offset = 0,
): void {
  const dyaw = angleDelta(from.yaw, to.yaw)
  const c = Math.cos(dyaw)
  const s = Math.sin(dyaw)
  const cFrom = from.position
  const cTo = to.position
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k] * 3
    const dx = points[i] - cFrom.x
    const dy = points[i + 1] - cFrom.y
    const dz = points[i + 2] - cFrom.z
    const o = (offset + k) * 3
    out[o] = cTo.x + dx * c - dy * s
    out[o + 1] = cTo.y + dx * s + dy * c
    out[o + 2] = cTo.z + dz
  }
}

/** 整体施加一次自车运动：静态点的场景流就是它 */
export function applyEgoMotion(points: Float32Array, out: Float32Array, motion: EgoMotion): void {
  const c = Math.cos(motion.dyaw)
  const s = Math.sin(motion.dyaw)
  const n = Math.min(points.length, out.length)
  for (let i = 0; i + 2 < n; i += 3) {
    const x = points[i]
    const y = points[i + 1]
    out[i] = x * c - y * s + motion.dx
    out[i + 1] = x * s + y * c + motion.dy
    out[i + 2] = points[i + 2]
  }
}

/** 两个位姿之间的精确刚体变换（有位姿时直接用这个，不必估计） */
export function egoBetween(from: { position: Vec3; yaw: number }, to: { position: Vec3; yaw: number }): EgoMotion {
  // p_b = R(from.yaw - to.yaw) p_a + R(-to.yaw) (t_from - t_to)
  const cos = Math.cos(to.yaw)
  const sin = Math.sin(to.yaw)
  const dxw = from.position.x - to.position.x
  const dyw = from.position.y - to.position.y
  return {
    dx: dxw * cos + dyw * sin,
    dy: -dxw * sin + dyw * cos,
    dyaw: -angleDelta(from.yaw, to.yaw),
    inliers: 0,
    rmse: 0,
    samples: 0,
  }
}

export interface EgoOptions {
  /** 地面带厚度（米）：取 z 的低分位往上这个高度内的点 */
  band?: number
  /** 低分位；0.02 对密集点云足够稳，稀疏点云可以调高 */
  quantile?: number
  /** 参与搜索的最大点数（会等距抽样）。越大越准越慢 */
  maxPoints?: number
  /** 搜索的平移上限（米） */
  maxShift?: number
  /** 搜索的偏航上限（弧度） */
  maxYaw?: number
  /** 内点阈值（米） */
  tolerance?: number
}

interface Band {
  x: Float32Array
  y: Float32Array
  count: number
}

/** 取地面带并等距抽样。等距而不是随机：同一份输入每次得到同一份采样 */
function groundBand(cloud: CloudLike, opts: Required<Pick<EgoOptions, 'band' | 'quantile' | 'maxPoints'>>): Band {
  const stride = Math.max(1, Math.floor(cloud.count / 40000))
  const zs: number[] = []
  for (let i = 0; i < cloud.count; i += stride) zs.push(cloud.positions[i * 3 + 2])
  zs.sort((a, b) => a - b)
  const q = zs.length ? zs[Math.min(zs.length - 1, Math.floor(zs.length * opts.quantile))] : 0
  const hi = q + opts.band

  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < cloud.count; i += stride) {
    const z = cloud.positions[i * 3 + 2]
    if (z < q || z > hi) continue
    xs.push(cloud.positions[i * 3])
    ys.push(cloud.positions[i * 3 + 1])
  }
  // 等距抽到 maxPoints：直接截断会只保留扫描线前段（多半是车头正前方），
  // 抽样才能覆盖整个地面带
  const step = Math.max(1, Math.ceil(xs.length / opts.maxPoints))
  const outX: number[] = []
  const outY: number[] = []
  for (let i = 0; i < xs.length; i += step) {
    outX.push(xs[i])
    outY.push(ys[i])
  }
  return { x: Float32Array.from(outX), y: Float32Array.from(outY), count: outX.length }
}

/** 目标点的网格索引：cell 取 1m，查询时看 3×3 邻域 */
function buildGrid(b: Band, cell: number): { map: Map<number, number[]>; key: (x: number, y: number) => number } {
  const map = new Map<number, number[]>()
  const key = (x: number, y: number) => {
    const gx = Math.floor(x / cell)
    const gy = Math.floor(y / cell)
    return (gx & 0xffff) * 0x10000 + (gy & 0xffff)
  }
  for (let i = 0; i < b.count; i++) {
    const k = key(b.x[i], b.y[i])
    const list = map.get(k)
    if (list) list.push(i)
    else map.set(k, [i])
  }
  return { map, key }
}

/**
 * 在给定位姿下打分：变换后的源点有多少能落进目标点云的 tolerance 内。
 * 返回内点数与残差平方和，用于粗搜比较与最终 rmse。
 */
function score(
  src: Band, dst: Band, grid: ReturnType<typeof buildGrid>,
  dx: number, dy: number, dyaw: number, tolerance: number,
): { inliers: number; sse: number } {
  const c = Math.cos(dyaw)
  const s = Math.sin(dyaw)
  const cell = 1
  const tol2 = tolerance * tolerance
  let inliers = 0
  let sse = 0
  for (let i = 0; i < src.count; i++) {
    const px = src.x[i] * c - src.y[i] * s + dx
    const py = src.x[i] * s + src.y[i] * c + dy
    const gx = Math.floor(px / cell)
    const gy = Math.floor(py / cell)
    let best = Infinity
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const list = grid.map.get(((gx + ox) & 0xffff) * 0x10000 + ((gy + oy) & 0xffff))
        if (!list) continue
        for (const j of list) {
          const ddx = dst.x[j] - px
          const ddy = dst.y[j] - py
          const d2 = ddx * ddx + ddy * ddy
          if (d2 < best) best = d2
        }
      }
    }
    if (best <= tol2) {
      inliers++
      sse += best
    }
  }
  return { inliers, sse }
}

/**
 * 从两帧点云估计自车运动。返回的方向约定见 `EgoMotion`。
 *
 * 估的是"a 帧 → b 帧"的映射，与 `egoBetween` 同一方向：
 * 有位姿时可以用 `egoBetween` 直接算，没位姿才用这个。
 */
export function estimateEgoMotion(
  a: CloudLike,
  b: CloudLike,
  opts: EgoOptions = {},
): EgoMotion {
  const band = opts.band ?? 0.35
  const quantile = opts.quantile ?? 0.02
  const maxPoints = opts.maxPoints ?? 400
  const maxShift = opts.maxShift ?? 3
  const maxYaw = opts.maxYaw ?? 0.2
  const tolerance = opts.tolerance ?? 0.3

  const src = groundBand(a, { band, quantile, maxPoints })
  const dst = groundBand(b, { band, quantile, maxPoints })
  const empty: EgoMotion = { dx: 0, dy: 0, dyaw: 0, inliers: 0, rmse: 0, samples: src.count }
  if (src.count < 20 || dst.count < 20) return empty

  const grid = buildGrid(dst, 1)
  let best = { dx: 0, dy: 0, dyaw: 0, inliers: -1, sse: 0 }

  // 粗搜：0.6m / 0.05rad。3m 范围内 11×11×9 = 1089 个位姿，每个 400 点
  const coarseShift = 0.6
  const coarseYaw = 0.05
  for (let yaw = -maxYaw; yaw <= maxYaw + 1e-9; yaw += coarseYaw) {
    for (let dx = -maxShift; dx <= maxShift + 1e-9; dx += coarseShift) {
      for (let dy = -maxShift; dy <= maxShift + 1e-9; dy += coarseShift) {
        const r = score(src, dst, grid, dx, dy, yaw, tolerance)
        if (r.inliers > best.inliers || (r.inliers === best.inliers && r.sse < best.sse)) {
          best = { dx, dy, dyaw: yaw, inliers: r.inliers, sse: r.sse }
        }
      }
    }
  }

  // 细搜：在粗解附近 0.15m / 0.01rad 内再走一遍
  const center = { ...best }
  for (let yaw = center.dyaw - coarseYaw; yaw <= center.dyaw + coarseYaw + 1e-9; yaw += 0.01) {
    for (let dx = center.dx - coarseShift; dx <= center.dx + coarseShift + 1e-9; dx += 0.15) {
      for (let dy = center.dy - coarseShift; dy <= center.dy + coarseShift + 1e-9; dy += 0.15) {
        const r = score(src, dst, grid, dx, dy, yaw, tolerance)
        if (r.inliers > best.inliers || (r.inliers === best.inliers && r.sse < best.sse)) {
          best = { dx, dy, dyaw: yaw, inliers: r.inliers, sse: r.sse }
        }
      }
    }
  }

  const rmse = best.inliers > 0 ? Math.sqrt(best.sse / best.inliers) : 0
  return {
    dx: best.dx,
    dy: best.dy,
    dyaw: best.dyaw,
    inliers: Math.max(0, best.inliers),
    rmse,
    samples: src.count,
  }
}

/**
 * 采样箭头段：每 6 个数一对端点（起点 xyz、终点 xyz）。
 *
 * `indices` 给了就只画这些点（"框内的点"），没给就按 stride 在全云上抽样。
 * 只画框内的点，是因为背景点每一个都在动（自车在动），画出来是一堵箭头墙，
 * 反而看不出目标往哪走。
 */
export function flowSegments(
  points: Float32Array,
  from: BoxGeometryLike,
  to: BoxGeometryLike,
  opts: { indices?: ArrayLike<number>; stride?: number; maxArrows?: number } = {},
): Float32Array {
  const maxArrows = Math.max(1, opts.maxArrows ?? 400)
  const picked: number[] = []
  if (opts.indices) {
    const step = Math.max(1, Math.ceil(opts.indices.length / maxArrows))
    for (let i = 0; i < opts.indices.length && picked.length < maxArrows; i += step) {
      picked.push(opts.indices[i])
    }
  } else {
    const stride = Math.max(1, opts.stride ?? 12)
    const total = points.length / 3
    for (let i = 0; i < total && picked.length < maxArrows; i += stride) picked.push(i)
  }
  if (!picked.length) return new Float32Array(0)
  const moved = new Float32Array(picked.length * 3)
  rigidFlow(points, picked, from, to, moved, 0)
  const out = new Float32Array(picked.length * 6)
  for (let k = 0; k < picked.length; k++) {
    const src = picked[k] * 3
    out[k * 6] = points[src]
    out[k * 6 + 1] = points[src + 1]
    out[k * 6 + 2] = points[src + 2]
    out[k * 6 + 3] = moved[k * 3]
    out[k * 6 + 4] = moved[k * 3 + 1]
    out[k * 6 + 5] = moved[k * 3 + 2]
  }
  return out
}
