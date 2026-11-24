/**
 * SUSTechPOINTS 格式适配器 —— 把现有能力接入统一入口。
 * 本身就是内部模型的"原生序列化"，因此直接复用 label.ts 的解析函数。
 */
import type { Box3D } from '../../types'
import { parseLabels, serializeLabels } from '../label'
import type { FormatAdapter, FormatParseResult, ParseOptions } from './types'

function isSustechObject(o: unknown): boolean {
  if (!o || typeof o !== 'object') return false
  const r = o as Record<string, unknown>
  return !!r.psr && typeof r === 'object' && 'obj_type' in r
}

export const sustechAdapter: FormatAdapter = {
  id: 'sustech',
  label: 'SUSTechPOINTS / 本工具',

  detect(raw: unknown, filename?: string) {
    if (typeof raw === 'string') {
      const s = raw.trim()
      if (!s.startsWith('[')) return 0
      try {
        const arr = JSON.parse(s) as unknown
        return Array.isArray(arr) && arr.length > 0 && isSustechObject(arr[0]) ? 1 : 0
      } catch { return 0 }
    }
    if (Array.isArray(raw) && raw.length > 0) return isSustechObject(raw[0]) ? 1 : 0
    // 文件名只是弱证据，给 0.3，不足以单独选中
    return filename && /label|sustech|000970/i.test(filename) ? 0.3 : 0
  },

  parse(raw: unknown, _options?: ParseOptions): FormatParseResult {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
    const boxes: Box3D[] = parseLabels(text)
    return { boxes, skipped: [], convention: 'LiDAR 自车系 · z-up · yaw 从 +x 起算（原生）' }
  },

  serialize(boxes: Box3D[]) {
    return serializeLabels(boxes)
  },
}
