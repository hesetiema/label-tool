/**
 * ============================================================
 * 逐点语义分割 —— 调色板与统计工具
 * ============================================================
 *
 * 语义分割和 3D 框是两种不同的标注对象：
 *   - 3D 框：稀疏、有朝向、描述"物体在哪、朝哪"
 *   - 语义分割：稠密、逐点、描述"每个点属于什么"
 *
 * 这一层只做三件事：
 *   1) 定义类别 id 与颜色（内置 SemanticKITTI 常用 19 类配色）
 *   2) 统计每个类别的点数（给 UI 的"语义分布"用）
 *   3) 把 labels 转成渲染可直接用的 rgb Float32Array
 *
 * 用 Uint16/Uint32 存 id 而不是字符串：百万点的字符串数组内存会爆。
 */
import type { PointCloud, SemanticClass, SemanticLabels } from './types'

/** SemanticKITTI 常用类别配色（颜色仅用于区分，非官方配色） */
export const DEFAULT_SEMANTIC_CLASSES: SemanticClass[] = [
  { id: 0, name: 'unlabeled', color: 0x555555 },
  { id: 1, name: 'car', color: 0x4fc3f7 },
  { id: 2, name: 'bicycle', color: 0x66bb6a },
  { id: 3, name: 'motorcycle', color: 0xffb74d },
  { id: 4, name: 'truck', color: 0x9575cd },
  { id: 5, name: 'other-vehicle', color: 0xab47bc },
  { id: 6, name: 'person', color: 0xff7043 },
  { id: 7, name: 'bicyclist', color: 0x26c6da },
  { id: 8, name: 'motorcyclist', color: 0xff4081 },
  { id: 9, name: 'road', color: 0x607d8b },
  { id: 10, name: 'parking', color: 0x455a64 },
  { id: 11, name: 'sidewalk', color: 0x9e9e9e },
  { id: 12, name: 'other-ground', color: 0x795548 },
  { id: 13, name: 'building', color: 0xffca28 },
  { id: 14, name: 'fence', color: 0x8d6e63 },
  { id: 15, name: 'vegetation', color: 0x2e7d32 },
  { id: 16, name: 'trunk', color: 0x5d4037 },
  { id: 17, name: 'terrain', color: 0x827717 },
  { id: 18, name: 'pole', color: 0x00bcd4 },
  { id: 19, name: 'traffic-sign', color: 0xffeb3b },
]

/** 取类别表：点云自带优先，否则用内置 */
export function semanticClassesOf(cloud: PointCloud): SemanticClass[] {
  return cloud.semanticClasses?.length ? cloud.semanticClasses : DEFAULT_SEMANTIC_CLASSES
}

/** id → 颜色整数；未登记的 id 用稳定哈希配色，避免全画成同一个颜色 */
export function semanticColor(id: number, classes?: SemanticClass[]): number {
  const found = (classes ?? DEFAULT_SEMANTIC_CLASSES).find((c) => c.id === id)
  if (found) return found.color
  // 未知 id：从调色板按 id 取模，保证同一 id 颜色稳定
  const palette = DEFAULT_SEMANTIC_CLASSES.slice(1)
  return palette[id % palette.length].color
}

/** id → 类别名 */
export function semanticName(id: number, classes?: SemanticClass[]): string {
  const found = (classes ?? DEFAULT_SEMANTIC_CLASSES).find((c) => c.id === id)
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
  for (const c of (classes ?? DEFAULT_SEMANTIC_CLASSES)) table.set(c.id, rgbOf(c.color))
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
 * 从 .label 二进制文件解析逐点标签（SemanticKITTI 约定：每点一个 uint32）。
 * 低 16 位是语义 id，高 16 位是实例 id——我们只取语义部分。
 */
export function parseSemanticLabelBin(buffer: ArrayBuffer, count?: number): Uint16Array {
  const available = Math.floor(buffer.byteLength / 4)
  const n = count ?? available
  if (n > available) throw new Error(`.label 文件只有 ${available} 个点，少于预期 ${n}`)
  const src = new Uint32Array(buffer, 0, n)
  const out = new Uint16Array(n)
  for (let i = 0; i < n; i++) out[i] = src[i] & 0xffff
  return out
}

/** 把 labels 导出为 SemanticKITTI 兼容的 uint32 二进制（低 16 位语义） */
export function serializeSemanticLabelBin(labels: SemanticLabels): ArrayBuffer {
  const buf = new ArrayBuffer(labels.length * 4)
  const out = new Uint32Array(buf)
  for (let i = 0; i < labels.length; i++) out[i] = labels[i]
  return buf
}

/**
 * 判断一个类别 id 是否属于"物体"（而非地面/背景）。
 * 演示脚本用它给程序化场景自动打语义标签。
 */
export function isObjectClass(id: number): boolean {
  return id >= 1 && id <= 8
}
