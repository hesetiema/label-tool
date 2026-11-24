/**
 * ============================================================
 * 大规模点云性能优化 —— 体素下采样 + 距离 LOD
 * ============================================================
 *
 * 【面试要点】"一帧激光雷达十几万个点，你的工具怎么不卡？"
 *   真实自动驾驶数据一帧可达 10~20 万点，一段序列百万级。浏览器要流畅渲染必须做减法和复用。
 *
 * 【三种优化手段，本模块实现前两种】
 *   1. 体素下采样（Voxel Grid Downsampling）—— 把空间切成小立方体，每格只保留一个代表点。
 *      点数从 O(N) 降到 O(空格数)，且能均匀保形。这是 PCL 里最常用的滤波器。
 *   2. 距离 LOD（Level of Detail）—— 离传感器近的点全保留（细节重要），远处按比例抽稀。
 *      符合人眼感知：远处的点本来就挤在一起，抽掉一半看不出区别。
 *   3. GPU 侧优化（渲染层做）—— BufferGeometry 一次性上传、TypedArray 零拷贝复用、
 *      避免每帧重建几何体。见 PointCloudViewer.setPointCloud。
 *
 * 【为什么默认用 Float32Array】
 *   JS 普通数组存的是指针+double，内存和 GC 压力大；Float32Array 是连续二进制块，
 *   正好是 WebGL 顶点缓冲需要的格式，可以直接交给 GPU，无需转换。
 */
import type { PointCloud } from '../types'
import { makeRng } from '../sample'

export interface DownsampleResult {
  cloud: PointCloud
  /** 耗时（毫秒），用于面试时用数据说话 */
  elapsedMs: number
  inputCount: number
  outputCount: number
}

/**
 * 体素网格下采样。
 * @param voxelSize 体素边长（米）。越大压缩越狠。0.3m 对城市道路场景效果较好。
 */
export function voxelDownsample(cloud: PointCloud, voxelSize = 0.3): DownsampleResult {
  const t0 = performance.now()
  const hasColor = !!cloud.colors
  const hasLabel = !!cloud.labels
  const hasInstance = !!cloud.instances
  // key 用整数三元组拼成字符串；值是格内所有点的累加，最后求平均作为代表点
  const buckets = new Map<string, {
    sx: number; sy: number; sz: number; sr: number; sg: number; sb: number
    /** 格内各类别计数，代表点取多数票，避免平均出一个不存在的类别 */
    labelVotes: Map<number, number>
    /** 实例 id → 对应语义 id 的票数，用于选出与胜出语义一致的实例 */
    instanceVotes: Map<number, Map<number, number>>
    n: number
  }>()

  for (let i = 0; i < cloud.count; i++) {
    const x = cloud.positions[i * 3]
    const y = cloud.positions[i * 3 + 1]
    const z = cloud.positions[i * 3 + 2]
    const key = `${Math.floor(x / voxelSize)},${Math.floor(y / voxelSize)},${Math.floor(z / voxelSize)}`
    let b = buckets.get(key)
    if (!b) {
      b = { sx: 0, sy: 0, sz: 0, sr: 0, sg: 0, sb: 0, labelVotes: new Map(), instanceVotes: new Map(), n: 0 }
      buckets.set(key, b)
    }
    b.sx += x; b.sy += y; b.sz += z; b.n++
    if (hasColor && cloud.colors) {
      b.sr += cloud.colors[i * 3]
      b.sg += cloud.colors[i * 3 + 1]
      b.sb += cloud.colors[i * 3 + 2]
    }
    if (hasLabel && cloud.labels) {
      const id = cloud.labels[i]
      b.labelVotes.set(id, (b.labelVotes.get(id) ?? 0) + 1)
    }
    if (hasInstance && cloud.instances && cloud.labels) {
      const inst = cloud.instances[i]
      const sem = cloud.labels[i]
      let bySem = b.instanceVotes.get(inst)
      if (!bySem) { bySem = new Map(); b.instanceVotes.set(inst, bySem) }
      bySem.set(sem, (bySem.get(sem) ?? 0) + 1)
    }
  }

  const count = buckets.size
  const positions = new Float32Array(count * 3)
  const colors = hasColor ? new Float32Array(count * 3) : undefined
  const labels = hasLabel ? new Uint16Array(count) : undefined
  const instances = hasInstance ? new Uint16Array(count) : undefined
  let j = 0
  for (const b of buckets.values()) {
    positions[j * 3] = b.sx / b.n
    positions[j * 3 + 1] = b.sy / b.n
    positions[j * 3 + 2] = b.sz / b.n
    if (colors) {
      colors[j * 3] = b.sr / b.n
      colors[j * 3 + 1] = b.sg / b.n
      colors[j * 3 + 2] = b.sb / b.n
    }
    if (labels) {
      let bestId = 0, bestVotes = -1
      for (const [id, votes] of b.labelVotes) {
        if (votes > bestVotes) { bestVotes = votes; bestId = id }
      }
      labels[j] = bestId
      // 实例取票数最多的那个，但排除与胜出语义不一致的实例——
      // 否则一辆车的点可能挂上行人的实例 id，跨帧轨迹就串了。
      if (instances && b.instanceVotes.size) {
        let bestInst = 0, bestInstVotes = -1
        for (const [inst, bySem] of b.instanceVotes) {
          const votes = bySem.get(bestId) ?? 0
          if (votes > bestInstVotes) { bestInstVotes = votes; bestInst = inst }
        }
        instances[j] = bestInstVotes > 0 ? bestInst : 0
      }
    }
    j++
  }

  return {
    cloud: { positions, count, colors, labels, instances, semanticClasses: cloud.semanticClasses },
    elapsedMs: performance.now() - t0,
    inputCount: cloud.count,
    outputCount: count,
  }
}

/**
 * 距离 LOD 抽稀：近处（<= nearRadius）全保留，远处按 farKeep 概率保留。
 * 用固定种子伪随机数保证结果可复现（教学演示时每次点击看到相同结果）。
 */
export function distanceLod(
  cloud: PointCloud,
  options: { nearRadius?: number; farKeep?: number; seed?: number } = {},
): DownsampleResult {
  const t0 = performance.now()
  const nearRadius = options.nearRadius ?? 35
  const farKeep = options.farKeep ?? 0.25
  const rng = makeRng(options.seed ?? 1234)
  const r2 = nearRadius * nearRadius
  const kept: number[] = []

  for (let i = 0; i < cloud.count; i++) {
    const x = cloud.positions[i * 3]
    const y = cloud.positions[i * 3 + 1]
    const z = cloud.positions[i * 3 + 2]
    const d2 = x * x + y * y + z * z
    if (d2 <= r2 || rng() < farKeep) kept.push(i)
  }

  const count = kept.length
  const positions = new Float32Array(count * 3)
  const colors = cloud.colors ? new Float32Array(count * 3) : undefined
  const labels = cloud.labels ? new Uint16Array(count) : undefined
  const instances = cloud.instances ? new Uint16Array(count) : undefined
  for (let j = 0; j < count; j++) {
    const i = kept[j]
    positions[j * 3] = cloud.positions[i * 3]
    positions[j * 3 + 1] = cloud.positions[i * 3 + 1]
    positions[j * 3 + 2] = cloud.positions[i * 3 + 2]
    if (colors && cloud.colors) {
      colors[j * 3] = cloud.colors[i * 3]
      colors[j * 3 + 1] = cloud.colors[i * 3 + 1]
      colors[j * 3 + 2] = cloud.colors[i * 3 + 2]
    }
    if (labels && cloud.labels) labels[j] = cloud.labels[i]
    if (instances && cloud.instances) instances[j] = cloud.instances[i]
  }

  return {
    cloud: { positions, count, colors, labels, instances, semanticClasses: cloud.semanticClasses },
    elapsedMs: performance.now() - t0,
    inputCount: cloud.count,
    outputCount: count,
  }
}

/**
 * 生成一帧百万级点云用于性能演示：地面 + 若干目标簇 + 远处散点。
 * 纯代码生成，无需下载大模型数据，打开即可压测。
 */
export function generateMassiveCloud(count = 1_000_000): PointCloud {
  const rng = makeRng(424242)
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const r = rng()
    let x: number, y: number, z: number
    if (r < 0.72) {
      // 路面：占据大部分点，范围 ±150m
      x = (rng() - 0.5) * 300
      y = (rng() - 0.5) * 250
      z = (rng() - 0.5) * 0.12
    } else if (r < 0.92) {
      // 目标簇：10 个车辆大小的长方体表面
      const ci = Math.floor(rng() * 10)
      const ccx = ((ci % 5) - 2) * 35 + 20
      const ccy = (Math.floor(ci / 5) - 0.5) * 40
      x = ccx + (rng() - 0.5) * 5
      y = ccy + (rng() - 0.5) * 2.2
      z = rng() * 2.2
    } else {
      // 远处建筑/植被散点
      x = (rng() - 0.5) * 400
      y = (rng() - 0.5) * 320
      z = rng() * 18
    }
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z
  }
  return { positions, count }
}
