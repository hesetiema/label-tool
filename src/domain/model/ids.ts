/**
 * ============================================================
 * 标识符类型与分配策略
 * ============================================================
 *
 * TrackId 用"数字字符串"而不是自增 number，是为了跟 SUSTechPOINTS 的
 * `obj_id` 完全兼容：导入导出时不需要任何映射表，老数据的 id 直接可用。
 *
 * 不在这里做全局计数器：id 必须能跨"导入 → 合并 → 拆分 → 撤销"保持稳定，
 * 所以分配逻辑放在 TrackStore（它能看到全部已用 id），这里只放纯函数。
 */

/** `${sceneId}#${startFrame}-${endFrame}` */
export type SampleId = string

/** 数字字符串，兼容 SUSTechPOINTS obj_id */
export type TrackId = string

/** 'Car' | 'Pedestrian' | ... 由类别表决定，domain 不做枚举 */
export type ClassId = string

export function isNumericId(id: string): boolean {
  return /^\d+$/.test(id)
}

/**
 * 找到下一个可用数字 id。
 *
 * 两个细节：
 * 1. 取"当前最大值 + 1"而不是"数量 + 1"：删除过中间 id 后不会复用旧 id，
 *    否则历史里被删的轨迹会和新建轨迹撞号，撤销时串数据。
 * 2. 非数字 id（模型输出的 UUID、手填的 'car-7'）不参与计算，只跳过。
 */
export function nextNumericId(used: Iterable<TrackId>, start = 1): TrackId {
  let max = start - 1
  const set = new Set<string>()
  for (const id of used) {
    set.add(id)
    if (isNumericId(id)) {
      const n = Number(id)
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  let next = Math.max(start, max + 1)
  while (set.has(String(next))) next++
  return String(next)
}

export function sampleIdOf(sceneId: string, range: [number, number]): SampleId {
  return `${sceneId}#${range[0]}-${range[1]}`
}
