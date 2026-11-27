/**
 * ============================================================
 * 跨任务一致性：把"关联"变成可检查的约束
 * ============================================================
 *
 * 多任务平台最容易出的错不是"某个任务标错了"，而是"两个任务各说各话"：
 * 框在 A 处、占据在 B 处、语义实例 id 指向一条不存在的轨迹。
 * 这类错人眼几乎发现不了 —— 逐格比对 64 万体素不现实，
 * 所以必须由规则自动发现，而且要能指名道姓（哪一帧、哪条轨迹、差多少）。
 *
 * 【本文件实现哪几条】
 *   I1 XT_OCC_BOX_CONTAINMENT  框内占据率 ≥ 90%
 *   I2 XT_OCC_CLASS_MISMATCH   框内体素类别与框类别一致（容差 10%）
 *   I3 XT_SEM_INSTANCE_UNMAPPED 语义实例 → 轨迹的映射不能悬空
 *
 * 【I4 / I5 为什么不在】
 *   I4（框内点光流 ≈ 刚体预测）需要逐点光流，而光流按设计不落盘，
 *   只能在有当前帧点云时现算 —— 它是"运行时检查"而不是"文档检查"。
 *   I5（车道线落在可行驶区域内）需要 fit 出车道线的采样点与 road 语义/占据，
 *   而 lane 任务此刻只有"能不能存能取"的实现（P3 的 UI 尚未做车道线编辑）。
 *   两条都留到 P5 规则引擎一起做，那时有统一的 rule registry 与 profile。
 *
 * 【90% 这个阈值哪来的】
 *   box carving 生成的占格天然满足 100%；不满足只可能来自外部导入、
 *   人工局部修正、或分辨率/标定误差。90% 是"允许少量体素缺失"的经验值，
 *   可配置。阈值太严会把每一个框都报成问题（等于没有规则），
 *   太松则漏掉"框和占据整体错位"这种最该抓的情形。
 */
import type { OccupancyGridSpec } from '../model/document'
import type { ClassId } from '../model/ids'
import type { TrackId } from '../model/ids'
import type { BoxGeometryLike } from '../model/geometry'
import { makeIssue, sortIssues, type QaIssue } from '../model/issue'
import { occupiedInBox, type OccupancyFrame } from '../derive/occupancy'

/** 参与校验的最小框形状：只要能算 OBB 内的体素就行 */
export interface CrossTaskBox extends BoxGeometryLike {
  id: TrackId
  label: ClassId
}

export interface CrossTaskOptions {
  /** I1：框内占据率下限，默认 0.9 */
  containment?: number
  /** I2：类别不符体素占比上限，默认 0.1 */
  classTolerance?: number
  /**
   * 覆盖率低于这个体素数的框跳过 I1/I2。
   * 远处的行人只有 1–2 个体素，随便一个体素缺失就是 50% 的"问题"，
   * 报出来只会淹没真正的问题。
   */
  minCoveredVoxels?: number
  /**
   * 允许的父类：`汽车 → 车辆`、`卡车 → 车辆` 这类层级关系。
   * 不传则要求严格相等 —— 占据类别表通常比框类别表粗，传了才合理。
   */
  parentOf?: (classId: ClassId) => ClassId[]
  /** 单条规则最多报多少条，防止一份坏数据刷出几万条 */
  maxPerRule?: number
}

export interface CrossTaskInput {
  frame: number
  boxes: readonly CrossTaskBox[]
  spec?: OccupancyGridSpec | null
  occ?: OccupancyFrame | null
  /** 语义实例 id → 轨迹 id */
  instanceMap?: Record<string, string> | null
  /** 当前文档里真实存在的轨迹 id（I3 判悬空用） */
  trackIds: Iterable<TrackId>
  opts?: CrossTaskOptions
}

export const CROSS_TASK_DEFAULTS = {
  containment: 0.9,
  classTolerance: 0.1,
  minCoveredVoxels: 8,
  maxPerRule: 200,
} as const

export function checkCrossTask(input: CrossTaskInput): QaIssue[] {
  const opts = { ...CROSS_TASK_DEFAULTS, ...(input.opts ?? {}) }
  const out: QaIssue[] = []
  const { frame, boxes, spec, occ } = input

  if (spec && occ) {
    let reported = 0
    for (const box of boxes) {
      if (reported >= opts.maxPerRule) break
      const stat = occupiedInBox(occ, spec, box)
      if (stat.covered < opts.minCoveredVoxels) continue
      const ratio = stat.covered > 0 ? stat.occupied / stat.covered : 0

      // ---- I1：框里应该有东西 ----
      if (ratio < opts.containment) {
        reported++
        out.push(
          makeIssue({
            code: 'XT_OCC_BOX_CONTAINMENT',
            ruleId: 'xt.occ-containment',
            severity: ratio < opts.containment / 2 ? 'error' : 'warn',
            scope: 'crossTask',
            targets: [
              { frame, trackId: box.id, task: 'occupancy' },
              { frame, trackId: box.id, task: 'boxes' },
            ],
            value: ratio,
            threshold: opts.containment,
            message: `第 ${frame} 帧 #${box.id}（${box.label}）框内占据率 ${(ratio * 100).toFixed(0)}%，应 ≥ ${(opts.containment * 100).toFixed(0)}%`,
            fixHint: '若框已修正，重新对这一帧生成占据；若是人工改过占据，检查是否漏补框内体素',
          }),
        )
      }

      // ---- I2：框里装的东西类别要对 ----
      if (stat.occupied > 0) {
        const allowed = new Set<ClassId>([box.label, ...(opts.parentOf?.(box.label) ?? [])])
        let mismatch = 0
        for (const [labelIdx, count] of stat.perClass) {
          const classId = spec.classIds[labelIdx]
          if (classId && allowed.has(classId)) continue
          mismatch += count
        }
        const badRatio = mismatch / stat.occupied
        if (badRatio > opts.classTolerance) {
          const top = [...stat.perClass.entries()]
            .map(([i, n]) => ({ classId: spec.classIds[i] ?? `#${i}`, n }))
            .sort((a, b) => b.n - a.n)
            .slice(0, 2)
            .map((x) => `${x.classId}×${x.n}`)
            .join('、')
          out.push(
            makeIssue({
              code: 'XT_OCC_CLASS_MISMATCH',
              ruleId: 'xt.occ-class',
              severity: 'warn',
              scope: 'crossTask',
              targets: [
                { frame, trackId: box.id, task: 'occupancy' },
                { frame, trackId: box.id, task: 'boxes' },
              ],
              value: badRatio,
              threshold: opts.classTolerance,
              message: `第 ${frame} 帧 #${box.id} 标为 ${box.label}，框内 ${(badRatio * 100).toFixed(0)}% 体素是别的类（${top}）`,
              fixHint:
                '确认是框类别错了，还是占据被邻近目标覆盖；占据冲突会按体积小的优先，小目标压过大目标时容易出这个提示',
            }),
          )
        }
      }
    }
  }

  // ---- I3：语义实例映射不能悬空 ----
  if (input.instanceMap) {
    const alive = new Set<TrackId>()
    for (const id of input.trackIds) alive.add(id)
    let reported = 0
    for (const [instance, trackId] of Object.entries(input.instanceMap)) {
      if (reported >= opts.maxPerRule) break
      if (alive.has(trackId)) continue
      reported++
      out.push(
        makeIssue({
          code: 'XT_SEM_INSTANCE_UNMAPPED',
          ruleId: 'xt.sem-instance',
          severity: 'error',
          scope: 'crossTask',
          targets: [{ task: 'semantic' }, { trackId }],
          message: `语义实例 ${instance} 指向轨迹 #${trackId}，但该轨迹不存在`,
          fixHint: '轨迹可能被删除或合并：删除映射项，或用合并后的轨迹 id 重新关联',
        }),
      )
    }
  }

  return sortIssues(out)
}

/**
 * 多帧汇总。逐帧统计与"最差帧"要给报告用，所以除了 issue 列表还回一份摘要。
 * 调用方（状态层）负责按帧加载占据帧，这里只做纯计算。
 */
export function checkCrossTaskFrames(
  frames: ReadonlyArray<Omit<CrossTaskInput, 'opts'> & { opts?: CrossTaskOptions }>,
): { issues: QaIssue[]; checked: number; framesWithIssues: number } {
  const issues: QaIssue[] = []
  let framesWithIssues = 0
  const seen = new Set<string>()
  for (const f of frames) {
    const found = checkCrossTask(f)
    if (found.length) {
      framesWithIssues++
      for (const issue of found) {
        const key = `${issue.code}|${issue.targets[0]?.frame ?? ''}|${issue.targets[0]?.trackId ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        issues.push(issue)
      }
    }
  }
  return { issues: sortIssues(issues), checked: frames.length, framesWithIssues }
}
