/**
 * ============================================================
 * 程序化示例点云 —— 让工具"开箱即用"
 * ============================================================
 *
 * 真实 PCD 有 3MB+，为了让项目下载即能跑，这里用代码生成一个
 * 仿真的道路场景：地面 + 几辆车 + 行人。同时这本身也是很好的学习材料：
 * 你能直观理解"点云"就是一堆 (x,y,z) 采样点。
 *
 * 坐标系遵循 z-up：x 前、y 左、z 上。
 */
import type { PointCloud, Box3D } from './types'

/** 简单的可重复伪随机数（固定种子），保证每次生成场景一致 */
export function makeRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 长按给定尺寸与 yaw 生成一个"长方体表面"的点云（模拟一辆车） */
export function addBoxSurface(
  out: number[],
  cx: number, cy: number, cz: number,
  L: number, W: number, H: number, yaw: number,
  density: number,
  rng: () => number,
) {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  const push = (lx: number, ly: number, lz: number) => {
    // 局部 → 世界：旋转 + 平移，加一点噪声模拟真实扫描
    const nx = (rng() - 0.5) * 0.06
    const ny = (rng() - 0.5) * 0.06
    const nz = (rng() - 0.5) * 0.06
    out.push(cx + lx * c - ly * s + nx, cy + lx * s + ly * c + ny, cz + lz + nz)
  }
  const n = Math.max(4, Math.floor(density))
  // 四个侧面 + 顶面
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1) - 0.5)
    // 前后两个面（x = ±L/2）
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 8; k++) push(sx * L / 2, t * W, cz > 0 ? (k / 7) * H - H / 2 : (k / 7) * H)
    }
    // 左右两个面（y = ±W/2）
    for (const sy of [-1, 1]) {
      for (let k = 0; k < 8; k++) push(t * L, sy * W / 2, (k / 7) * H)
    }
    // 顶面（z = H）
    for (let k = 0; k < n; k++) push(t * L, (k / (n - 1) - 0.5) * W, H)
  }
}

/**
 * 生成演示场景。返回点云 + 这份场景的"标准答案"框（方便你对照学习）。
 */
export function generateDemoScene(): { cloud: PointCloud; boxes: Box3D[] } {
  const rng = makeRng(20261119)
  const pts: number[] = []

  // 1) 地面：一片带轻微起伏的点，模拟路面扫描
  for (let i = 0; i < 6000; i++) {
    const x = (rng() - 0.5) * 80
    const y = (rng() - 0.5) * 60
    const z = (rng() - 0.5) * 0.05
    pts.push(x, y, z)
  }
  // 2) 车道线：两条虚线，帮助建立空间感
  for (let s = -35; s < 35; s += 2) {
    for (let d = 0; d < 12; d++) {
      for (const yLine of [-2.5, 2.5]) {
        pts.push(s + d * 0.08, yLine + (rng() - 0.5) * 0.1, 0.02)
      }
    }
  }

  // 3) 目标物：几辆车 / 行人 / 骑行者
  const specs: { label: string; cx: number; cy: number; L: number; W: number; H: number; yaw: number }[] = [
    { label: 'Car', cx: 18, cy: 2.5, L: 4.5, W: 1.8, H: 1.5, yaw: 0.05 },
    { label: 'Car', cx: 6, cy: -2.5, L: 4.6, W: 1.85, H: 1.55, yaw: Math.PI - 0.08 },
    { label: 'Truck', cx: 28, cy: 2.5, L: 8.5, W: 2.5, H: 3.2, yaw: 0.02 },
    { label: 'Pedestrian', cx: 2, cy: 6, L: 0.6, W: 0.6, H: 1.75, yaw: 0 },
    { label: 'Rider', cx: -8, cy: -3, L: 2.0, W: 0.8, H: 1.7, yaw: 0.3 },
    { label: 'Cyclist', cx: -14, cy: 2, L: 1.7, W: 0.6, H: 1.7, yaw: Math.PI / 2 },
  ]

  const boxes: Box3D[] = specs.map((sp, idx) => {
    addBoxSurface(pts, sp.cx, sp.cy, 0, sp.L, sp.W, sp.H, sp.yaw, 16, rng)
    return {
      id: String(idx + 1),
      label: sp.label,
      position: { x: sp.cx, y: sp.cy, z: sp.H / 2 },
      scale: { x: sp.L, y: sp.W, z: sp.H },
      yaw: sp.yaw,
    }
  })

  return {
    cloud: { positions: new Float32Array(pts), count: pts.length / 3 },
    boxes,
  }
}
