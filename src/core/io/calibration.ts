/**
 * ============================================================
 * 相机标定与投影 —— 把 3D 框投到 2D 图像上
 * ============================================================
 *
 * 对应 docs/06 的理论，也对照原仓库 public/js/image.js 的 box_to_2d_points。
 *
 * 投影公式（针孔相机模型）：
 *   P_camera = Extrinsic · P_world          外参：世界 → 相机
 *   P_pixel_h = Intrinsic · P_camera        内参：相机 → 像素（齐次）
 *   (u, v) = P_pixel_h.xy / P_pixel_h.z     透视除法
 *
 * 矩阵约定（很重要，来自原仓库源码）：
 *  - extrinsic 是 16 个数的 4×4，【行主序】存储，平移在索引 3/7/11
 *    （原仓库 calib.js 用 extrinsic[3],[7],[11] 取平移，可证实）
 *  - intrinsic 是 9 个数的 3×3，【行主序】：[fx,0,cx, 0,fy,cy, 0,0,1]
 *  - 采用列向量右乘：P' = M · P
 *  - 相机坐标系：z 轴沿光轴向前，因此投影要求 z>0（点在相机前方）
 */
import type { Box3D } from '../types'
import { boxToVertices } from '../geometry/box'

/** 单个像素点坐标 */
export interface PixelPoint { u: number; v: number }

/** 标定数据（对应 calib/front.json） */
export interface Calibration {
  extrinsic: number[]  // 4×4 行主序
  intrinsic: number[]  // 3×3 行主序
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
 * 把一个世界坐标点投影到像素坐标。
 * @returns 投影点；若点在相机后方(z<=0)返回 null
 */
export function projectPoint(
  world: [number, number, number],
  calib: Calibration,
): PixelPoint | null {
  // 世界 → 相机（外参，齐次坐标补 1）
  const cam = matVec(calib.extrinsic, [world[0], world[1], world[2], 1], 4)
  if (cam[2] <= 0) return null // 在相机后方，投影无意义

  // 相机 → 像素（内参，3×3 乘前三个分量）
  const px = matVec(calib.intrinsic, [cam[0], cam[1], cam[2]], 3)
  // 透视除法：除以深度
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
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
]

/** 从 JSON 文本解析标定数据 */
export function parseCalibration(json: string): Calibration {
  const raw = JSON.parse(json)
  return { extrinsic: raw.extrinsic, intrinsic: raw.intrinsic }
}
