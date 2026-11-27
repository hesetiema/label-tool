/**
 * ============================================================
 * Velodyne / KITTI `.bin` 点云解析
 * ============================================================
 *
 * KITTI 的 velodyne 数据是**没有头部**的裸 float32 小端数组，
 * 每点固定 4 个数：`x y z intensity`（intensity 是反射率，0~1 之间，
 * 有的工具导出成 0~255，所以只当相对强度用，不做归一化假设）。
 *
 *   000000.bin = [x0 y0 z0 i0][x1 y1 z1 i1]...
 *
 * 少数工具会导出每点 3 个数（丢掉 intensity），也一并支持。
 *
 * 【为什么需要"猜"步长】
 *   没有魔数、没有元素个数，唯一的信息就是字节数。
 *   字节数 / 4 能被 4 整除 → 按每点 4 个数读（KITTI 约定，优先）；
 *   否则能被 3 整除 → 按每点 3 个数读。
 *   12 个 float 两种都能整除，这时**必须**优先 4 —— 因为 KITTI 是这个格式的
 *   绝对主流，猜 3 会把 intensity 当成下一帧的 x，读出一堆乱点。
 *
 * 【和 PCD 一样的脏数据防线】
 *   无效点（NaN / Infinity）会在写入时被剔除。点云里混进 NaN 会让 three.js
 *   算出 NaN 包围球，整个场景直接全黑 —— 只错几个点，代价却是看不见任何东西。
 */
import type { PointCloud } from '../types'

/** 一个点可能占的 float 个数（4 = xyz+intensity，3 = 纯 xyz） */
const STRIDE_WITH_INTENSITY = 4
const STRIDE_XYZ_ONLY = 3

/**
 * 推测步长：优先 4（KITTI 约定），退到 3。
 * 返回 0 表示字节数既不整除 4 也不整除 3 → 不是 float32 点云。
 */
export function binStride(buffer: ArrayBuffer): 3 | 4 | 0 {
  if (buffer.byteLength === 0 || buffer.byteLength % 4 !== 0) return 0
  const floats = buffer.byteLength / 4
  if (floats % STRIDE_WITH_INTENSITY === 0) return STRIDE_WITH_INTENSITY
  if (floats % STRIDE_XYZ_ONLY === 0) return STRIDE_XYZ_ONLY
  return 0
}

/**
 * 解析 `.bin` 点云。
 * @param buffer 文件原始字节（小端 float32 数组）
 * @param stride 每点 float 个数；不传则按字节数推测
 */
export function parseVelodyneBin(buffer: ArrayBuffer, stride?: 3 | 4): PointCloud {
  if (buffer.byteLength === 0) throw new Error('.bin 文件是空的')
  const step = stride ?? binStride(buffer)
  if (!step) {
    throw new Error(`.bin 字节数 ${buffer.byteLength} 不是 float32 点云的整数倍（每点 3 或 4 个数）`)
  }

  const src = new Float32Array(buffer)
  const total = src.length / step
  const positions = new Float32Array(total * 3)
  const intensity = step === STRIDE_WITH_INTENSITY ? new Float32Array(total) : undefined

  // 写入游标：跳过无效点后按实际点数收紧，避免尾部留一串 0
  let w = 0
  for (let i = 0; i < total; i++) {
    const x = src[i * step]
    const y = src[i * step + 1]
    const z = src[i * step + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    positions[w * 3] = x
    positions[w * 3 + 1] = y
    positions[w * 3 + 2] = z
    if (intensity) intensity[w] = src[i * step + 3]
    w++
  }

  if (w === 0) throw new Error('.bin 里没有有效点（全部是 nan）')
  if (w === total) return { positions, count: w, ...(intensity ? { intensity } : {}) }
  return {
    positions: positions.slice(0, w * 3),
    count: w,
    ...(intensity ? { intensity: intensity.slice(0, w) } : {}),
  }
}
