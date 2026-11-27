/**
 * ============================================================
 * 逐点语义分割 —— SemanticKITTI 约定、调色板与统计工具
 * ============================================================
 *
 * 语义分割和 3D 框是两种不同的标注对象：
 *   - 3D 框：稀疏、有朝向、描述"物体在哪、朝哪"
 *   - 语义分割：稠密、逐点、描述"每个点属于什么"
 *
 * 这一层做四件事：
 *   1) 按 SemanticKITTI 官方 semantic-kitti.yaml 定义原始类别 id 与配色
 *   2) 提供 learning_map：原始 34 类 → 训练用 20 类（id 0-19）
 *   3) 解析 .label 的 uint32：低 16 位语义、高 16 位跨帧一致的实例 id
 *   4) 把 labels 转成渲染可直接用的 rgb Float32Array
 *
 * 【为什么要区分原始 id 和 learning id】
 * 官方原始 id 是稀疏的：car=10、road=40、moving-car=252……
 * 训练时通过 learning_map 映射成连续的 0-19（moving-car 并回 car）。
 * 标注工具必须保留原始 id——一旦提前合并，moving-car 和 car 就无法区分，
 * 而且再也无法和官方评测/可视化工具对齐。只有在送进模型时才做映射。
 *
 * 用 Uint16/Uint32 存 id 而不是字符串：百万点的字符串数组内存会爆。
 */
import type { PointCloud, SemanticClass, SemanticLabels } from './types'

/**
 * SemanticKITTI 原始类别表（id 与官方 config/semantic-kitti.yaml 完全一致）。
 * 颜色由官方 color_map 的 BGR 转成 0xRRGGBB，便于十六进制书写。
 */
export const SEMANTIC_KITTI_CLASSES: SemanticClass[] = [
  { id: 0, name: 'unlabeled', color: 0x000000 },
  { id: 1, name: 'outlier', color: 0x0000ff },
  { id: 10, name: 'car', color: 0x6496f5 },
  { id: 11, name: 'bicycle', color: 0x64e6f5 },
  { id: 13, name: 'bus', color: 0x6450fa },
  { id: 15, name: 'motorcycle', color: 0x1e3c96 },
  { id: 16, name: 'on-rails', color: 0x0000ff },
  { id: 18, name: 'truck', color: 0x501eb4 },
  { id: 20, name: 'other-vehicle', color: 0x0000ff },
  { id: 30, name: 'person', color: 0xff1e1e },
  { id: 31, name: 'bicyclist', color: 0xff28c8 },
  { id: 32, name: 'motorcyclist', color: 0x961e5a },
  { id: 40, name: 'road', color: 0xff00ff },
  { id: 44, name: 'parking', color: 0xff96ff },
  { id: 48, name: 'sidewalk', color: 0x4b004b },
  { id: 49, name: 'other-ground', color: 0xaf004b },
  { id: 50, name: 'building', color: 0xffc800 },
  { id: 51, name: 'fence', color: 0xff7832 },
  { id: 52, name: 'other-structure', color: 0xff9600 },
  { id: 60, name: 'lane-marking', color: 0x96ffaa },
  { id: 70, name: 'vegetation', color: 0x00af00 },
  { id: 71, name: 'trunk', color: 0x873c00 },
  { id: 72, name: 'terrain', color: 0x96f050 },
  { id: 80, name: 'pole', color: 0xfff096 },
  { id: 81, name: 'traffic-sign', color: 0xff0000 },
  { id: 99, name: 'other-object', color: 0x32ffff },
  { id: 252, name: 'moving-car', color: 0x6496f5 },
  { id: 253, name: 'moving-bicyclist', color: 0xff28c8 },
  { id: 254, name: 'moving-person', color: 0xff1e1e },
  { id: 255, name: 'moving-motorcyclist', color: 0x961e5a },
  { id: 256, name: 'moving-on-rails', color: 0x0000ff },
  { id: 257, name: 'moving-bus', color: 0x6450fa },
  { id: 258, name: 'moving-truck', color: 0x501eb4 },
  { id: 259, name: 'moving-other-vehicle', color: 0x0000ff },
]

/** 兼容旧代码里的名字；默认调色板现在就是官方原始类别表 */
export const DEFAULT_SEMANTIC_CLASSES = SEMANTIC_KITTI_CLASSES

/**
 * 官方 learning_map：原始 id → 训练 id (0-19)。
 * 不可区分的类（bus/on-rails/moving-*）被并到最接近的类别，
 * other-structure / other-object / outlier 归为 unlabeled(0)。
 */
export const SEMANTIC_KITTI_LEARNING_MAP: Readonly<Record<number, number>> = {
  0: 0,
  1: 0,
  10: 1,
  11: 2,
  13: 5,
  15: 3,
  16: 5,
  18: 4,
  20: 5,
  30: 6,
  31: 7,
  32: 8,
  40: 9,
  44: 10,
  48: 11,
  49: 12,
  50: 13,
  51: 14,
  52: 0,
  60: 9,
  70: 15,
  71: 16,
  72: 17,
  80: 18,
  81: 19,
  99: 0,
  252: 1,
  253: 7,
  254: 6,
  255: 8,
  256: 5,
  257: 5,
  258: 4,
  259: 5,
}

/** 训练 id → 类别名，用于展示映射后的统计（与官方 learning_map_inv 对应） */
export const LEARNING_CLASS_NAMES = [
  'unlabeled',
  'car',
  'bicycle',
  'motorcycle',
  'truck',
  'other-vehicle',
  'person',
  'bicyclist',
  'motorcyclist',
  'road',
  'parking',
  'sidewalk',
  'other-ground',
  'building',
  'fence',
  'vegetation',
  'trunk',
  'terrain',
  'pole',
  'traffic-sign',
] as const

/** 原始 id → 训练 id；未登记的 id 保持原值（便于外部自定义类别） */
export function toLearningId(rawId: number): number {
  return SEMANTIC_KITTI_LEARNING_MAP[rawId] ?? rawId
}

/** 训练 id → 原始 id（取该类的第一个代表；unlabeled 映射回 0） */
export function fromLearningId(learningId: number): number {
  const entry = Object.entries(SEMANTIC_KITTI_LEARNING_MAP).find(([, v]) => v === learningId)
  return entry ? Number(entry[0]) : learningId
}

/** 取类别表：点云自带优先，否则用官方 SemanticKITTI 原始类别表 */
export function semanticClassesOf(cloud: PointCloud): SemanticClass[] {
  return cloud.semanticClasses?.length ? cloud.semanticClasses : SEMANTIC_KITTI_CLASSES
}

/** id → 颜色整数；未登记的 id 用稳定哈希配色，避免全画成同一个颜色 */
export function semanticColor(id: number, classes?: SemanticClass[]): number {
  const found = (classes ?? SEMANTIC_KITTI_CLASSES).find((c) => c.id === id)
  if (found) return found.color
  // 未知 id：从调色板按 id 取模，保证同一 id 颜色稳定
  const palette = SEMANTIC_KITTI_CLASSES.filter((c) => c.id > 0 && c.id < 250)
  return palette[id % palette.length].color
}

/** id → 类别名 */
export function semanticName(id: number, classes?: SemanticClass[]): string {
  const found = (classes ?? SEMANTIC_KITTI_CLASSES).find((c) => c.id === id)
  return found?.name ?? `class_${id}`
}

/** 整数颜色 → [r,g,b] 归一化到 0~1 */
export function rgbOf(color: number): [number, number, number] {
  return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255]
}

/**
 * 把逐点标签转成 Three.js 顶点颜色缓冲。
 * 结果可直接作为 BufferAttribute('color', 3) 使用。
 */
export function labelsToColors(labels: SemanticLabels, classes?: SemanticClass[]): Float32Array {
  const out = new Float32Array(labels.length * 3)
  // 先建 id→rgb 查找表，避免每个点都 find 一次（百万点会差几个数量级）
  const table = new Map<number, [number, number, number]>()
  for (const c of classes ?? SEMANTIC_KITTI_CLASSES) table.set(c.id, rgbOf(c.color))
  for (let i = 0; i < labels.length; i++) {
    let rgb = table.get(labels[i])
    if (!rgb) {
      rgb = rgbOf(semanticColor(labels[i], classes))
      table.set(labels[i], rgb)
    }
    out[i * 3] = rgb[0]
    out[i * 3 + 1] = rgb[1]
    out[i * 3 + 2] = rgb[2]
  }
  return out
}

export interface SemanticStat {
  id: number
  name: string
  color: number
  count: number
  ratio: number
}

/** 统计每类点数，按点数降序（UI 直接渲染） */
export function semanticStats(cloud: PointCloud): SemanticStat[] {
  if (!cloud.labels?.length) return []
  const counts = new Map<number, number>()
  for (let i = 0; i < cloud.labels.length; i++) {
    const id = cloud.labels[i]
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const classes = semanticClassesOf(cloud)
  const total = cloud.labels.length || 1
  return [...counts.entries()]
    .map(([id, count]) => ({
      id,
      name: semanticName(id, classes),
      color: semanticColor(id, classes),
      count,
      ratio: count / total,
    }))
    .sort((a, b) => b.count - a.count)
}

/**
 * 解析 SemanticKITTI .label 二进制。
 *
 * 每个点一个 uint32：
 *   - 低 16 位：语义 id（官方原始 id，不是 learning_map 之后的 0-19）
 *   - 高 16 位：实例 id，同一目标跨帧保持一致，0 表示无实例（地面/背景）
 *
 * 实例 id 是接轨迹/时序质检的关键：同一个 car 在连续帧里共享同一个 id，
 * 无需重新做框匹配。以前版本把它丢掉了，这里保留下来。
 */
export interface SemanticLabelData {
  labels: Uint16Array
  instances: Uint16Array
  /** 实际出现的不同语义 id 数量（用于状态栏提示） */
  classCount: number
  /** 实际出现的不同实例 id 数量（不含 0） */
  instanceCount: number
}

export function parseSemanticLabelBin(buffer: ArrayBuffer, count?: number): SemanticLabelData {
  const available = Math.floor(buffer.byteLength / 4)
  const n = count ?? available
  if (n > available) throw new Error(`.label 文件只有 ${available} 个点，少于预期 ${n}`)
  const src = new Uint32Array(buffer, 0, n)
  const labels = new Uint16Array(n)
  const instances = new Uint16Array(n)
  const classes = new Set<number>()
  const insts = new Set<number>()
  for (let i = 0; i < n; i++) {
    const raw = src[i]
    const semanticId = raw & 0xffff
    const instanceId = raw >>> 16
    labels[i] = semanticId
    instances[i] = instanceId
    classes.add(semanticId)
    if (instanceId !== 0) insts.add(instanceId)
  }
  return { labels, instances, classCount: classes.size, instanceCount: insts.size }
}

/**
 * 导出为 SemanticKITTI 兼容的 uint32 二进制。
 * 传入 instances 时写回高 16 位，保证导出的 .label 能被官方 devkit 读取。
 */
export function serializeSemanticLabelBin(labels: SemanticLabels, instances?: Uint16Array): ArrayBuffer {
  if (instances && instances.length !== labels.length) {
    throw new Error('语义标签与实例 id 数量不一致')
  }
  const buf = new ArrayBuffer(labels.length * 4)
  const out = new Uint32Array(buf)
  for (let i = 0; i < labels.length; i++) {
    out[i] = (labels[i] & 0xffff) | (((instances?.[i] ?? 0) & 0xffff) << 16)
  }
  return buf
}
