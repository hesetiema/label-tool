/** 适配器的小工具：类别映射、数字解析、跳过统计 */

import type { SkippedInfo } from './types'

/** 生成一个"先查内置表、再查用户表"的映射基底 */
export function defaultNameMap(base: Record<string, string>): Record<string, string> {
  return { ...base }
}

/**
 * 类别名映射。优先级：用户表 > 内置表 > 原名保留。
 * 映射值为 '__skip__' 表示该目标不导入（如 KITTI DontCare）。
 */
export function mapName(raw: string, builtin: Record<string, string>, user?: Record<string, string>): string {
  if (user && Object.prototype.hasOwnProperty.call(user, raw)) return user[raw]
  if (Object.prototype.hasOwnProperty.call(builtin, raw)) return builtin[raw]
  return raw
}

/** 严格数字解析：空串 / 非法值抛错，避免静默变成 0 让框跑到原点 */
export function parseNumber(v: unknown, field: string): number {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`字段 ${field} 不是有效数字：${String(v)}`)
  return n
}

/** 累加跳过原因，供 UI 显示"跳过了 N 个 DontCare" */
export function skippedAdd(list: SkippedInfo[], reason: string) {
  const found = list.find((x) => x.reason === reason)
  if (found) found.count++
  else list.push({ reason, count: 1 })
}
