/**
 * 格式适配层统一入口。
 *
 * 对外只暴露两个函数：
 *   detectLabelFormat(text, filename) —— 嗅探（用于状态提示）
 *   parseLabelsAuto(text, filename, options) —— 识别 + 解析一步到位
 *
 * 嗅探采用"各适配器打分、取最高"的方式；平局时按数组顺序优先。
 * 顺序很关键：DAIR-V2X 的 JSON 也带 dimensions/location，必须排在
 * nuScenes 的 translation/size 之前，否则会误判——这里用 detect 的
 * 严格特征（是否有 3d_dimensions / 是否 type 字段）保证不混。
 */
import type { AutoParseResult, FormatAdapter, LabelFormat, ParseOptions } from './types'
import { sustechAdapter } from './sustech'
import { kittiAdapter, dairAdapter } from './kitti'
import { nuscenesAdapter } from './nuscenes'
import { waymoAdapter } from './waymo'

export const FORMAT_ADAPTERS: FormatAdapter[] = [
  sustechAdapter,
  dairAdapter,
  nuscenesAdapter,
  waymoAdapter,
  kittiAdapter, // 文本格式放最后，避免被 JSON 适配器抢先
]

export const FORMAT_LABELS: Record<LabelFormat, string> = {
  sustech: 'SUSTechPOINTS / 本工具',
  kitti: 'KITTI label_2',
  'dair-v2x': 'DAIR-V2X',
  nuscenes: 'nuScenes',
  waymo: 'Waymo Open',
}

/** 解析成对象供适配器嗅探；失败时退回原字符串 */
function normalize(raw: string): unknown {
  const s = raw.trim()
  if (!s) return raw
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      return JSON.parse(s)
    } catch {
      /* 保持字符串 */
    }
  }
  return raw
}

/** 嗅探格式；无法判断时返回 null */
export function detectLabelFormat(text: string, filename?: string): LabelFormat | null {
  const raw = normalize(text)
  let best: { id: LabelFormat; score: number } | null = null
  for (const adapter of FORMAT_ADAPTERS) {
    const score = adapter.detect(raw, filename)
    if (score > 0 && (!best || score > best.score)) best = { id: adapter.id, score }
  }
  return best?.id ?? null
}

/** 自动识别并解析标注。识别不出来时抛错，让上层显示明确提示 */
export function parseLabelsAuto(text: string, filename?: string, options?: ParseOptions): AutoParseResult {
  const raw = normalize(text)
  let best: { adapter: FormatAdapter; score: number } | null = null
  for (const adapter of FORMAT_ADAPTERS) {
    const score = adapter.detect(raw, filename)
    if (score > 0 && (!best || score > best.score)) best = { adapter, score }
  }
  if (!best) {
    throw new Error('未能识别标注格式：支持 SUSTechPOINTS / KITTI / DAIR-V2X / nuScenes / Waymo(JSON)')
  }
  const result = best.adapter.parse(raw, options)
  return {
    ...result,
    format: best.adapter.id,
    formatLabel: FORMAT_LABELS[best.adapter.id],
  }
}

export type { AutoParseResult, FormatAdapter, FormatParseResult, LabelFormat, ParseOptions } from './types'
