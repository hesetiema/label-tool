/**
 * ============================================================
 * OBB 几何算法 —— 3D 框的数学核心
 * ============================================================
 *
 * 一个 3D 框由 position + scale + yaw 定义，但要渲染它、要判断点是否在框内，
 * 都需要把它展开成 8 个角点，或反过来从一堆点算出最合适的框。
 *
 * 两个核心操作：
 *  1) boxToVertices : 框 → 8 个角点（用于渲染线框、导出 JSON）
 *  2) fitBoxToPoints: 一堆点 → 最贴合的框（用于"拖拽自动拟合"）
 */
import type { Box3D, Vec3 } from './types'

/** 绕竖直轴(z)旋转一个 xy 平面上的点。yaw 为弧度 */
function rotateYaw(x: number, y: number, yaw: number): [number, number] {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [x * c - y * s, x * s + y * c]
}

/**
 * 由框参数计算 8 个角点，顺序与 SUSTechPOINTS 保持一致。
 *
 * 局部坐标下（中心为原点），先按 length(x)/width(y)/height(z) 造 8 点：
 *   车头面(x=+L/2): [+L,-W,-H] [+L,+W,-H] [+L,+W,+H] [+L,-W,+H]
 *   车尾面(x=-L/2): [-L,-W,-H] [-L,+W,-H] [-L,+W,+H] [-L,-W,+H]
 * 然后每个点绕 z 轴转 yaw，再加中心 position。
 *
 * 返回展平数组 [x,y,z,1, x,y,z,1, ...]，直接可写入 label JSON 的 vertices。
 */
export function boxToVertices(box: Box3D): number[] {
  const hx = box.scale.x / 2
  const hy = box.scale.y / 2
  const hz = box.scale.z / 2
  // 局部坐标：[x, y, z]，顺序见上方注释
  const local: [number, number, number][] = [
    [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz],
    [-hx, -hy, -hz], [-hx, hy, -hz], [-hx, hy, hz], [-hx, -hy, hz],
  ]
  const out: number[] = []
  for (const [lx, ly, lz] of local) {
    const [rx, ry] = rotateYaw(lx, ly, box.yaw)
    out.push(
      box.position.x + rx,
      box.position.y + ry,
      box.position.z + lz,
      1,
    )
  }
  return out
}

/**
 * 自动框拟合（auto box fitting）—— 交互体验的灵魂功能。
 *
 * 思路（原仓库用的经典做法）：
 *  1) 把所有点投影到框的局部坐标系（逆向旋转 yaw）
 *  2) 在局部系里，框变成轴对齐的，直接取 xyz 的 min/max 就是尺寸和中心
 *  3) 再转回世界坐标
 *
 * 这就是"在 BEV 上画个大致区域，工具自动把框贴到车上"背后的原理。
 * 稍加改进：去掉地面点（z 太低）可以避免框被地面拉大。
 *
 * @param positions 点云坐标（展平）
 * @param indices   候选点的索引（BEV 框选出来的）
 * @param initialYaw 初始朝向，可传 0 或由 PCA 估计
 */
export function fitBoxToPoints(
  positions: Float32Array,
  indices: number[],
  initialYaw = 0,
  minZRatio = 0.15,
): { position: Vec3; scale: Vec3; yaw: number } | null {
  if (indices.length === 0) return null

  // 先求这批点的 z 范围，用于剔除地面点
  let zMin = Infinity
  let zMax = -Infinity
  for (const i of indices) {
    const z = positions[i * 3 + 2]
    if (z < zMin) zMin = z
    if (z > zMax) zMax = z
  }
  const zCut = zMin + (zMax - zMin) * minZRatio

  // 逆旋转到局部系，统计 min/max
  const c = Math.cos(-initialYaw)
  const s = Math.sin(-initialYaw)
  let lxMin = Infinity, lxMax = -Infinity
  let lyMin = Infinity, lyMax = -Infinity
  let lzMin = Infinity, lzMax = -Infinity
  let used = 0

  for (const i of indices) {
    const px = positions[i * 3]
    const py = positions[i * 3 + 1]
    const pz = positions[i * 3 + 2]
    if (pz < zCut) continue // 跳过近地面的点
    const lx = px * c - py * s
    const ly = px * s + py * c
    if (lx < lxMin) lxMin = lx
    if (lx > lxMax) lxMax = lx
    if (ly < lyMin) lyMin = ly
    if (ly > lyMax) lyMax = ly
    if (pz < lzMin) lzMin = pz
    if (pz > lzMax) lzMax = pz
    used++
  }
  if (used < 3) return null

  // 局部系中心，再转回世界系
  const cx = (lxMin + lxMax) / 2
  const cy = (lyMin + lyMax) / 2
  const cc = Math.cos(initialYaw)
  const ss = Math.sin(initialYaw)
  const position: Vec3 = {
    x: cx * cc - cy * ss,
    y: cx * ss + cy * cc,
    z: (lzMin + lzMax) / 2,
  }
  // 沿局部 x/y 的跨度即为 length/width（yaw 对齐后）
  const scale: Vec3 = {
    x: Math.max(lxMax - lxMin, 0.3),
    y: Math.max(lyMax - lyMin, 0.3),
    z: Math.max(lzMax - lzMin, 0.3),
  }
  return { position, scale, yaw: initialYaw }
}

/**
 * 用 PCA（主成分分析）估计点云的主方向角。
 * 原理：车的点云沿车身方向分布最长，协方差矩阵最大特征值对应的方向
 * 就是车身朝向。这是自动偏航角预测的"传统算法版"（无需深度学习）。
 */
export function estimateYawByPCA(positions: Float32Array, indices: number[]): number {
  if (indices.length < 3) return 0
  let mx = 0, my = 0
  for (const i of indices) {
    mx += positions[i * 3]
    my += positions[i * 3 + 1]
  }
  mx /= indices.length
  my /= indices.length

  // 2D 协方差矩阵 [[sxx, sxy],[sxy, syy]]
  let sxx = 0, syy = 0, sxy = 0
  for (const i of indices) {
    const dx = positions[i * 3] - mx
    const dy = positions[i * 3 + 1] - my
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  // 主方向角 = 0.5 * atan2(2*sxy, sxx - syy)
  return 0.5 * Math.atan2(2 * sxy, sxx - syy)
}

/** 判断一个 xy 点是否落在框的 BEV 投影（旋转矩形）内 */
export function pointInBoxBev(box: Box3D, x: number, y: number): boolean {
  const dx = x - box.position.x
  const dy = y - box.position.y
  const [lx, ly] = rotateYaw(dx, dy, -box.yaw)
  return Math.abs(lx) <= box.scale.x / 2 && Math.abs(ly) <= box.scale.y / 2
}
