/**
 * ============================================================
 * QaIssue —— 统一问题模型
 * ============================================================
 *
 * 现有 `TemporalIssue` 只有 type/severity/objId/frame/detail/value：
 *   - 没有机器可读的 code（报告没法按原因码统计、没法做趋势）
 *   - 没有 task（跨任务规则无处安放）
 *   - 没有 fixHint（UI 只能显示"检查失败"）
 *   - 只能指一个目标（跨任务冲突往往涉及两个目标）
 *
 * 这里定义统一模型，并提供从旧结构映射的适配函数。
 * 旧字段保留在适配函数里，避免一次性改 UI —— 这也是 P5 规则引擎的输入契约。
 */
import type { TrackId } from './ids'
import type { TaskKey } from './document'
import type { Command } from './command'

export type QaSeverity = 'info' | 'warn' | 'error' | 'blocker'

export interface QaTarget {
  frame?: number
  trackId?: TrackId
  task?: TaskKey
}

export interface QaIssue {
  /** 机器可读原因码，例如 'TRK_GAP'、'XT_OCC_BOX_CONTAINMENT' */
  code: string
  ruleId: string
  severity: QaSeverity
  scope: 'frame' | 'track' | 'sequence' | 'crossTask' | 'task'
  /** 一个 issue 可能涉及多个目标/帧（跨任务冲突） */
  targets: QaTarget[]
  /** 实测值与阈值，报告里可直接画分布 */
  value?: number
  threshold?: number
  message: string
  /** 给标注员看的修复建议，而不是"检查失败" */
  fixHint?: string
  /** 可一键修复时给出命令，决定 UI 是否出按钮 */
  autoFix?: { command: Command }
}

/**
 * 旧时序问题的形状（与 `core/sequence/temporalQA.ts` 的 TemporalIssue 同构）。
 * 这里显式列字段而不是 import，是为了让 domain 不依赖 core 的具体模块；
 * 测试里会用真实 TemporalIssue 做结构性赋值校验。
 */
export interface LegacyTemporalIssue {
  type: 'id_switch' | 'speed_jump' | 'jitter' | 'track_gap'
  severity: 'error' | 'warn'
  objId: string
  label: string
  frame: number
  detail: string
  value: number
}

/** 旧 type → 原因码 + 规则 id + 修复建议 */
const TEMPORAL_RULE_MAP: Record<
  LegacyTemporalIssue['type'],
  {
    code: string
    ruleId: string
    scope: QaIssue['scope']
    fixHint: string
  }
> = {
  id_switch: {
    code: 'TRK_ID_SWITCH',
    ruleId: 'trk.id-switch',
    scope: 'track',
    fixHint: '检查该帧前后是否把两个目标串成了一个 ID；必要时用轨迹拆分',
  },
  speed_jump: {
    code: 'TRK_SPEED_JUMP',
    ruleId: 'trk.speed-jump',
    scope: 'track',
    fixHint: '确认中间帧位置是否标错，或该目标是否真的急加减速',
  },
  jitter: {
    code: 'TRK_JITTER',
    ruleId: 'trk.jitter',
    scope: 'track',
    fixHint: '逐帧独立标注容易抖动；可对非关键帧做平滑',
  },
  track_gap: {
    code: 'TRK_GAP',
    ruleId: 'trk.gap',
    scope: 'track',
    fixHint: '若是真实遮挡，把缺口帧标为 occluded；否则补齐标注或执行插值',
  },
}

/** 旧 → 新。保留原 type 在 message 里，方便迁移期对照 */
export function fromTemporalIssue(issue: LegacyTemporalIssue): QaIssue {
  const rule = TEMPORAL_RULE_MAP[issue.type]
  return {
    code: rule.code,
    ruleId: rule.ruleId,
    severity: issue.severity,
    scope: rule.scope,
    targets: [{ frame: issue.frame, trackId: issue.objId, task: 'boxes' }],
    value: issue.value,
    message: issue.detail,
    fixHint: rule.fixHint,
  }
}

/** 通用的构造入口：规则实现里少写样板 */
export function makeIssue(opts: {
  code: string
  ruleId: string
  severity: QaSeverity
  scope: QaIssue['scope']
  targets: QaTarget[]
  message: string
  value?: number
  threshold?: number
  fixHint?: string
}): QaIssue {
  return {
    code: opts.code,
    ruleId: opts.ruleId,
    severity: opts.severity,
    scope: opts.scope,
    targets: opts.targets,
    ...(opts.value !== undefined ? { value: opts.value } : {}),
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    message: opts.message,
    ...(opts.fixHint ? { fixHint: opts.fixHint } : {}),
  }
}

/** 按严重度排序：报告首屏永远先看 blocker/error */
export function sortIssues(issues: QaIssue[]): QaIssue[] {
  const rank: Record<QaSeverity, number> = { blocker: 0, error: 1, warn: 2, info: 3 }
  return [...issues].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || (a.targets[0]?.frame ?? 0) - (b.targets[0]?.frame ?? 0),
  )
}
