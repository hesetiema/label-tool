/**
 * ============================================================
 * 相机标定与投影 —— 把 3D 框投到 2D 图像上
 * ============================================================
 *
 * 对应 docs/06 的理论，也对照原仓库 public/js/image.js 的 box_to_2d_points。
 *
 * 投影公式（针孔相机模型 + 可选畸变）：
 *   P_camera = Extrinsic · P_world          外参：世界 → 相机
 *   (xn, yn) = (X/Z, Y/Z)                   归一化相机平面
 *   (xd, yd) = distort(xn, yn)              径向-切向畸变（可选）
 *   P_pixel_h = Intrinsic · [xd,yd,1]       内参：相机 → 像素（齐次）
 *   (u, v) = P_pixel_h.xy / P_pixel_h.z     透视除法
 *
 * 矩阵约定（很重要，来自原仓库源码）：
 *  - extrinsic 是 16 个数的 4×4，【行主序】存储，平移在索引 3/7/11
 *    （原仓库 calib.js 用 extrinsic[3],[7],[11] 取平移，可证实）
 *  - intrinsic 是 9 个数的 3×3，【行主序】：[fx,0,cx, 0,fy,cy, 0,0,1]
 *  - 采用列向量右乘：P' = M · P
 *  - 相机坐标系：z 轴沿光轴向前，因此投影要求 z>0（点在相机前方）
 *
 * 【畸变系数约定】
 *  distortion 是 OpenCV 顺序的 [k1, k2, p1, p2, k3]：
 *    k1/k2/k3 径向，p1/p2 切向。可只给前 4 项（k3 缺省为 0）。
 *  与 KITTI 的 calib D:、OpenCalib 输出 JSON 的 Distortion: 同序。
 *  没有这个字段时走原来的无畸变快速路径，行为与改动前完全一致。
 *
 *  注意：这里做的是「投影时加畸变」（projectPoints 模型）。若数据集提供的
 *  图像已经过去畸变（如 KITTI 的 P2 已是 rectified 投影矩阵），就不要再
 *  传 distortion，否则会二次校正。
 */
import type { Box3D } from '../types'
import { boxToVertices } from '../geometry/box'

/** 单个像素点坐标 */
export interface PixelPoint {
  u: number
  v: number
}

/** 标定数据（对应 calib/front.json） */
export interface Calibration {
  extrinsic: number[] // 4×4 行主序
  intrinsic: number[] // 3×3 行主序
  /** OpenCV 径向-切向畸变 [k1,k2,p1,p2,k3]，可选；无此字段视为针孔模型 */
  distortion?: number[]
}

/**
 * 行主序矩阵 × 列向量。
 * @param m 矩阵，行数由 n 决定（n=4 时 m 长 16，n=3 时 m 长 9）
 * @param v 列向量，长度 n
 * @returns 结果向量，长度 n
 *
 * 行主序索引：m[row*n + col]，所以 result[i] = Σ_j m[i*n+j] * v[j]
 */
export function matVec(m: number[], v: number[], n: number): number[] {
  const out = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let j = 0; j < n; j++) sum += m[i * n + j] * v[j]
    out[i] = sum
  }
  return out
}

/**
 * 对归一化相机平面坐标施加径向-切向畸变（OpenCV 标准公式）。
 *
 *   r² = x² + y²
 *   radial = 1 + k1·r² + k2·r⁴ + k3·r⁶
 *   xd = x·radial + 2·p1·x·y + p2·(r² + 2x²)
 *   yd = y·radial + p1·(r² + 2y²) + 2·p2·x·y
 *
 * @param x 归一化 x = X/Z
 * @param y 归一化 y = Y/Z
 * @param d 畸变系数，至少 4 项；k3 可省略
 */
export function distortNormalized(x: number, y: number, d?: number[]): [number, number] {
  if (!d || d.length < 4) return [x, y]
  const [k1, k2, p1, p2] = d
  const k3 = d[4] ?? 0
  const r2 = x * x + y * y
  const r4 = r2 * r2
  const radial = 1 + k1 * r2 + k2 * r4 + k3 * r4 * r2
  return [x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x), y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y]
}

/**
 * 把一个世界坐标点投影到像素坐标。
 * @returns 投影点；若点在相机后方(z<=0)返回 null
 */
export function projectPoint(world: [number, number, number], calib: Calibration): PixelPoint | null {
  // 世界 → 相机（外参，齐次坐标补 1）
  const cam = matVec(calib.extrinsic, [world[0], world[1], world[2], 1], 4)
  if (cam[2] <= 0) return null // 在相机后方，投影无意义

  // 无畸变：保持原来的调用顺序，避免任何浮点路径变化
  if (!calib.distortion) {
    const px = matVec(calib.intrinsic, [cam[0], cam[1], cam[2]], 3)
    return { u: px[0] / px[2], v: px[1] / px[2] }
  }

  // 有畸变：先归一化 → 施加畸变 → 乘回深度 → 再走原内参矩阵。
  // 乘回 Z 是为了保留内参矩阵的完整语义（含 skew 等非常规项）。
  const [nx, ny] = distortNormalized(cam[0] / cam[2], cam[1] / cam[2], calib.distortion)
  const px = matVec(calib.intrinsic, [nx * cam[2], ny * cam[2], cam[2]], 3)
  return { u: px[0] / px[2], v: px[1] / px[2] }
}

/**
 * 把一个 3D 框的 8 个角点投影成 8 个像素点。
 *
 * 返回 8 个点的数组（可能含 null）。只要有任意一个角点在相机后方，
 * 就返回 null（整框不可见）——与原仓库 all_points_in_image_range 行为一致。
 */
export function projectBox(box: Box3D, calib: Calibration): PixelPoint[] | null {
  const v = boxToVertices(box)
  const out: PixelPoint[] = []
  for (let i = 0; i < 8; i++) {
    const p = projectPoint([v[i * 4], v[i * 4 + 1], v[i * 4 + 2]], calib)
    if (!p) return null
    out.push(p)
  }
  return out
}

/**
 * 8 个投影点按什么顺序连线成框？
 * boxToVertices 的顺序是：车头面 0-1-2-3，车尾面 4-5-6-7（见 box.ts）。
 * 这里返回 12 条边的端点索引对，供 canvas 画线。
 */
export const BOX_EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
]

/**
 * 从各种常见字段名/格式里提取畸变系数。
 * 支持：distortion / Distortion / dist_coeffs / D，数组或空格/逗号分隔字符串。
 * 少于 4 项、含非数字的坏数据会被忽略——宁可当针孔模型，也不要把投影搞崩。
 */
function readDistortion(raw: Record<string, unknown>): number[] | undefined {
  for (const key of ['distortion', 'Distortion', 'dist_coeffs', 'dist_coeff', 'D']) {
    let value = raw[key]
    if (typeof value === 'string')
      value = value
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
    if (!Array.isArray(value) || value.length < 4) continue
    const nums = value.slice(0, 5).map(Number)
    if (!nums.every(Number.isFinite)) continue
    return nums
  }
  return undefined
}

/** 从 JSON 文本解析标定数据 */
export function parseCalibration(json: string): Calibration {
  const raw = JSON.parse(json)
  const distortion = readDistortion(raw)
  return {
    extrinsic: raw.extrinsic,
    intrinsic: raw.intrinsic,
    ...(distortion ? { distortion } : {}),
  }
}
