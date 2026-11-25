/**
 * ============================================================
 * TaskRegistry —— 任务即插件
 * ============================================================
 *
 * 【为什么用注册表而不是 switch】
 *   加一个任务要改的地方原本散在五处：`buildSnapshot` 的字段列表、
 *   导出、质检、面板的 tab、命令的 affects。每加一次漏一处的概率都不低。
 *   注册表把"这个任务怎么校验、怎么派生、多大、覆盖多少"收成一份契约，
 *   新增任务 = 新增一个文件 + 注册一行；规则引擎也能按 key 遍历，
 *   不需要知道具体是占据还是光流。
 *
 * 【为什么 validate 返回问题而不是抛异常】
 *   导入别人的文档时，"占据帧号越界"应该显示成一条问题让人决定怎么办，
 *   而不是整份文档打不开。抛异常适合"程序写错了"，不适合"数据不合规"。
 *
 * 【为什么 estimateBytes 不读 BlobStore】
 *   domain 不认识存储。这里给的是"描述对象 + 已知载荷大小"的估算，
 *   真实字节数由 BlobStore 自己报；两者用途不同：
 *   前者用于"这个任务要不要懒加载"，后者用于配额。
 */
import type { SampleDocument, TaskKey } from './document'
import type { QaIssue, QaSeverity } from './issue'
import { makeIssue } from './issue'
import { isPayloadRef } from '../store/blobRefs'
import { trackInvariantViolations } from './track'
import { validateVla } from '../vla/rules'

export interface TaskProgress {
  done: number
  total: number
  /** frames：按帧数算进度；items：按条目数算（车道线、指令段） */
  unit: 'frames' | 'items'
  /** UI 上的一句话补充，例如"3 条待复核" */
  note?: string
}

export interface TaskAdapter<P = unknown> {
  key: TaskKey
  label: string
  /** app 层映射到具体 .vue；空字符串表示本期没有编辑器 */
  editor: string
  /** boxes 是必选任务，其余可以"这个样本不做" */
  optional: boolean
  validate: (payload: P | undefined, doc: SampleDocument) => QaIssue[]
  /** 从其他任务衍生；无衍生能力返回 null */
  deriveFrom?: (doc: SampleDocument) => P | null
  /** 导出为外部格式；无导出返回 null */
  serialize?: (payload: P, doc: SampleDocument) => ArrayBuffer | string
  estimateBytes: (payload: P | undefined) => number
  progress?: (doc: SampleDocument) => TaskProgress
}

/**
 * 类型擦除后的适配器。
 * 注册表要同时装 `TaskAdapter<OccupancyTaskData>` 与 `TaskAdapter<Track[]>`，
 * 这些载荷类型互不相干，只有擦掉类型参数才能放进同一个 Map。
 * 取用方按 key 自己知道该期待什么 —— 这也是"注册表 + 结构化契约"要付的代价。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTaskAdapter = TaskAdapter<any>

export class TaskRegistry {
  private map = new Map<TaskKey, AnyTaskAdapter>()

  register<P>(adapter: TaskAdapter<P>): this {
    this.map.set(adapter.key, adapter)
    return this
  }

  get(key: TaskKey): AnyTaskAdapter | undefined {
    return this.map.get(key)
  }

  get keys(): TaskKey[] {
    return [...this.map.keys()]
  }

  list(): AnyTaskAdapter[] {
    return [...this.map.values()]
  }

  /** 文档里该任务的载荷。boxes 在 tasks.boxes，其余同名字段 */
  payload(doc: SampleDocument, key: TaskKey): unknown {
    return (doc.tasks as Record<string, unknown>)[key]
  }

  /** 全量校验。已注册但文档里没有的任务视为"本样本不做"，不报问题 */
  validate(doc: SampleDocument): QaIssue[] {
    const out: QaIssue[] = []
    for (const adapter of this.map.values()) {
      const payload = this.payload(doc, adapter.key)
      if (payload === undefined && adapter.optional) continue
      out.push(...adapter.validate(payload as never, doc))
    }
    return out
  }

  /** 各任务体积估算之和（描述对象 + 已知 blob 的字节数） */
  estimateBytes(doc: SampleDocument): number {
    let total = 0
    for (const adapter of this.map.values()) {
      total += adapter.estimateBytes(this.payload(doc, adapter.key) as never)
    }
    return total
  }

  progress(doc: SampleDocument): Array<{ key: TaskKey; label: string; present: boolean; progress: TaskProgress | null }> {
    return this.list().map((adapter) => {
      const payload = this.payload(doc, adapter.key)
      return {
        key: adapter.key,
        label: adapter.label,
        present: payload !== undefined,
        progress: adapter.progress ? adapter.progress(doc) : null,
      }
    })
  }
}

/* ------------------------------------------------------------------
 * 各任务的适配器
 * ------------------------------------------------------------------ */

function span(doc: SampleDocument): number {
  return Math.max(0, doc.range[1] - doc.range[0] + 1)
}

const SEV: QaSeverity = 'warn'

function frameListIssues(
  frames: ReadonlyArray<{ frame: number }> | undefined,
  doc: SampleDocument,
  label: string,
  task: TaskKey,
): QaIssue[] {
  if (!frames?.length) return []
  const out: QaIssue[] = []
  let prev = -Infinity
  for (const entry of frames) {
    if (!Number.isInteger(entry.frame) || entry.frame < doc.range[0] || entry.frame > doc.range[1]) {
      out.push(makeIssue({
        code: 'TASK_FRAME_OUT_OF_RANGE',
        ruleId: `task.${task}.frame-range`,
        severity: SEV,
        scope: 'task',
        targets: [{ frame: entry.frame, task }],
        message: `${label} 第 ${entry.frame} 帧超出样本范围 [${doc.range[0]}, ${doc.range[1]}]`,
        fixHint: '重新生成该任务的载荷，或把帧号裁剪到样本范围内',
      }))
    }
    if (entry.frame === prev) {
      out.push(makeIssue({
        code: 'TASK_FRAME_DUPLICATE',
        ruleId: `task.${task}.duplicate`,
        severity: SEV,
        scope: 'task',
        targets: [{ frame: entry.frame, task }],
        message: `${label} 第 ${entry.frame} 帧重复出现`,
        fixHint: '同一帧只能有一条载荷引用；后一条会覆盖前一条，删掉重复项',
      }))
    }
    prev = entry.frame
  }
  return out
}

/** 关键帧帧号的并集 —— 比"物化每一帧"便宜几个数量级 */
function keyframeFrameCount(doc: SampleDocument): number {
  const set = new Set<number>()
  for (const t of doc.tasks.boxes.tracks) for (const k of t.keyframes) set.add(k.frame)
  return set.size
}

export const boxesAdapter: TaskAdapter<{ tracks: import('./track').Track[] }> = {
  key: 'boxes',
  label: '3D 框',
  editor: 'ObjectPanel',
  optional: false,
  validate(payload, doc) {
    const out: QaIssue[] = []
    const tracks = payload?.tracks ?? []
    const seen = new Set<string>()
    let reported = 0
    for (const t of tracks) {
      if (seen.has(t.id) && reported < 20) {
        reported++
        out.push(makeIssue({
          code: 'TRK_DUPLICATE_ID',
          ruleId: 'trk.duplicate-id',
          severity: 'error',
          scope: 'track',
          targets: [{ trackId: t.id, task: 'boxes' }],
          message: `轨迹 id #${t.id} 重复`,
          fixHint: '重复 id 会让撤销与导出串数据，必须改号',
        }))
      }
      seen.add(t.id)
      for (const v of trackInvariantViolations(t)) {
        if (reported++ >= 40) break
        out.push(makeIssue({
          code: 'TRK_INVARIANT',
          ruleId: 'trk.invariant',
          severity: 'error',
          scope: 'track',
          targets: [{ trackId: t.id, task: 'boxes', frame: t.keyframes[0]?.frame }],
          message: v,
          fixHint: '用轨迹修复（插值/重设生命周期）或删掉这条轨迹重标',
        }))
      }
    }
    void doc
    return out
  },
  estimateBytes(payload) {
    // 每次编辑只重写描述对象；关键帧数量 × 约 120 字节（含 source/attributes）
    const n = payload?.tracks.reduce((sum, t) => sum + t.keyframes.length, 0) ?? 0
    return n * 120
  },
  progress(doc) {
    return { done: keyframeFrameCount(doc), total: span(doc), unit: 'frames' }
  },
}

export const occupancyAdapter: TaskAdapter<import('./document').OccupancyTaskData> = {
  key: 'occupancy',
  label: '占据栅格',
  editor: 'TaskPanel',
  optional: true,
  validate(payload, doc) {
    const out: QaIssue[] = []
    const spec = payload?.spec
    if (spec) {
      if (!(spec.resolution > 0)) {
        out.push(makeIssue({
          code: 'TASK_OCC_SPEC',
          ruleId: 'task.occupancy.spec',
          severity: 'error',
          scope: 'task',
          targets: [{ task: 'occupancy' }],
          message: `占据分辨率非法：${spec.resolution}`,
          fixHint: '重新生成占据（规格来自生成时的配置）',
        }))
      }
      for (const axis of ['x', 'y', 'z'] as const) {
        const n = spec.size?.[axis]
        if (!Number.isInteger(n) || n <= 0) {
          out.push(makeIssue({
            code: 'TASK_OCC_SPEC',
            ruleId: 'task.occupancy.spec',
            severity: 'error',
            scope: 'task',
            targets: [{ task: 'occupancy' }],
            message: `占据网格 size.${axis} 非法：${n}`,
            fixHint: '重新生成占据',
          }))
        }
      }
    }
    out.push(...frameListIssues(payload?.frames, doc, '占据', 'occupancy'))
    for (const entry of payload?.frames ?? []) {
      if (!isPayloadRef(entry.ref)) {
        out.push(makeIssue({
          code: 'TASK_BAD_REF',
          ruleId: 'task.occupancy.ref',
          severity: 'error',
          scope: 'task',
          targets: [{ frame: entry.frame, task: 'occupancy' }],
          message: `占据第 ${entry.frame} 帧的引用不是 payload 键：${entry.ref}`,
          fixHint: '重新生成该帧占据',
        }))
        break
      }
    }
    return out
  },
  estimateBytes(payload) {
    if (!payload) return 0
    // 一帧 RLE 实测 20–60KB，取中间值估；spec 与 ref 字符串按条数算
    const frames = payload.frames?.length ?? 0
    return frames * 40_000 + JSON.stringify(payload.spec ?? {}).length + frames * 48
  },
  progress(doc) {
    const frames = doc.tasks.occupancy?.frames?.length ?? 0
    return { done: frames, total: span(doc), unit: 'frames' }
  },
}

export const flowAdapter: TaskAdapter<import('./document').FlowTaskData> = {
  key: 'flow',
  label: '光流 / 自车运动',
  editor: 'TaskPanel',
  optional: true,
  validate(payload, doc) {
    const out: QaIssue[] = []
    out.push(...frameListIssues(payload?.ego, doc, '自车运动', 'flow'))
    for (const e of payload?.ego ?? []) {
      if (!Number.isFinite(e.dx) || !Number.isFinite(e.dy) || !Number.isFinite(e.dyaw)) {
        out.push(makeIssue({
          code: 'TASK_FLOW_NAN',
          ruleId: 'task.flow.finite',
          severity: 'error',
          scope: 'task',
          targets: [{ frame: e.frame, task: 'flow' }],
          message: `自车运动第 ${e.frame} 帧含非有限值`,
          fixHint: '重新估计该帧自车运动',
        }))
        break
      }
      if (e.rmse !== undefined && e.rmse > 0.2) {
        out.push(makeIssue({
          code: 'TASK_FLOW_UNRELIABLE',
          ruleId: 'task.flow.rmse',
          severity: 'warn',
          scope: 'task',
          targets: [{ frame: e.frame, task: 'flow' }],
          value: e.rmse,
          threshold: 0.2,
          message: `自车运动第 ${e.frame} 帧残差 ${e.rmse.toFixed(2)}m，超过 0.2m`,
          fixHint: '地面点太少或坡道/急转弯：这帧的光流只能参考，不要用于精度评估',
        }))
        break
      }
    }
    if (payload?.pointFlowRef !== undefined && !isPayloadRef(payload.pointFlowRef)) {
      out.push(makeIssue({
        code: 'TASK_BAD_REF',
        ruleId: 'task.flow.ref',
        severity: 'error',
        scope: 'task',
        targets: [{ task: 'flow' }],
        message: `逐点光流引用不是 payload 键：${payload.pointFlowRef}`,
        fixHint: '清空该引用后重新导出',
      }))
    }
    return out
  },
  estimateBytes(payload) {
    if (!payload) return 0
    return (payload.ego?.length ?? 0) * 40 + (payload.pointFlowRef ? 1 : 0) * 400_000
  },
  progress(doc) {
    const ego = doc.tasks.flow?.ego?.length ?? 0
    return { done: ego, total: span(doc), unit: 'frames' }
  },
}

export const semanticAdapter: TaskAdapter<import('./document').SemanticTaskData> = {
  key: 'semantic',
  label: '逐点语义',
  editor: '',
  optional: true,
  validate(payload) {
    const out: QaIssue[] = []
    if (!payload) return out
    if (payload.pointLabelsRef !== undefined && !isPayloadRef(payload.pointLabelsRef)) {
      out.push(makeIssue({
        code: 'TASK_BAD_REF',
        ruleId: 'task.semantic.ref',
        severity: 'error',
        scope: 'task',
        targets: [{ task: 'semantic' }],
        message: `逐点语义引用不是 payload 键：${payload.pointLabelsRef}`,
        fixHint: '重新导入语义标签',
      }))
    }
    for (const [instance, trackId] of Object.entries(payload.instanceMap ?? {})) {
      if (!instance.trim()) {
        out.push(makeIssue({
          code: 'TASK_SEM_INSTANCE_EMPTY',
          ruleId: 'task.semantic.instance',
          severity: 'warn',
          scope: 'task',
          targets: [{ task: 'semantic' }],
          message: `语义实例映射里有空实例 id（指向 #${trackId}）`,
          fixHint: '空实例 id 多半是导入时列没对齐，删掉该条',
        }))
        break
      }
    }
    return out
  },
  estimateBytes(payload) {
    if (!payload) return 0
    return (payload.pointLabelsRef ? 600_000 : 0) + ((Object.keys(payload.instanceMap ?? {}).length) * 24)
  },
  progress(doc) {
    const sem = doc.tasks.semantic
    const mapped = Object.keys(sem?.instanceMap ?? {}).length
    return {
      done: sem?.pointLabelsRef ? 1 : 0,
      total: sem?.pointLabelsRef ? 1 : doc.tasks.boxes.tracks.length || 1,
      unit: 'items',
      ...(mapped ? { note: `${mapped} 个实例已映射` } : {}),
    }
  },
}

export const laneAdapter: TaskAdapter<import('./document').LaneTaskData> = {
  key: 'lane',
  label: '车道线',
  editor: '',
  optional: true,
  validate(payload) {
    const out: QaIssue[] = []
    const ids = new Set<string>()
    for (const lane of payload?.lanes ?? []) {
      if (!lane.id || ids.has(lane.id)) {
        out.push(makeIssue({
          code: 'TASK_LANE_ID',
          ruleId: 'task.lane.id',
          severity: SEV,
          scope: 'task',
          targets: [{ task: 'lane' }],
          message: `车道线 id 为空或重复：${lane.id}`,
          fixHint: '车道线 id 在样本内必须唯一',
        }))
        break
      }
      ids.add(lane.id)
      if (!lane.points || lane.points.length < 2) {
        out.push(makeIssue({
          code: 'TASK_LANE_POINTS',
          ruleId: 'task.lane.points',
          severity: SEV,
          scope: 'task',
          targets: [{ task: 'lane' }],
          message: `车道线 ${lane.id} 少于 2 个点`,
          fixHint: '一个点无法定义方向，至少两个点',
        }))
        break
      }
    }
    return out
  },
  estimateBytes(payload) {
    return (payload?.lanes?.reduce((n, l) => n + l.points.length * 24 + 64, 0)) ?? 0
  },
  progress(doc) {
    return { done: doc.tasks.lane?.lanes?.length ?? 0, total: 0, unit: 'items' }
  },
}

/**
 * VLA：语言—动作对齐。
 *
 * 校验逻辑在 `domain/vla/rules`，不写在这里 —— 它有 11 条规则、需要自己的
 * 选项与辅助函数，塞进 task.ts 会让这个文件变成"所有任务的 validate 合集"，
 * 而它存在的意义恰恰是"每个任务只需要在注册表里占一行"。
 */
export const vlaAdapter: TaskAdapter<import('./vla').VlaTaskData> = {
  key: 'vla',
  label: 'VLA 对齐',
  editor: 'VlaPanel',
  optional: true,
  validate(payload, doc) {
    return validateVla(payload, doc)
  },
  estimateBytes(payload) {
    if (!payload) return 0
    const ins = payload.instructions.length * 180
    const ch = payload.channels.reduce((n, c) => n + c.values.length * 8 + 64, 0)
    return ins + ch + 200
  },
  progress(doc) {
    const vla = doc.tasks.vla
    if (!vla) return { done: 0, total: 0, unit: 'items' }
    const total = vla.instructions.length
    const accepted = vla.instructions.filter((s) => s.review === 'accepted' || s.review === 'none').length
    const pending = total - accepted
    return {
      done: accepted,
      total,
      unit: 'items',
      ...(pending ? { note: `${pending} 条待确认` } : {}),
    }
  },
}

/**
 * 默认注册表。
 *
 * vla 在 P4 之前**故意不注册**：注册了却没有任何校验与编辑器，
 * 只会在"任务"面板里多一个永远 0% 的条目。现在它有 11 条规则和独立面板了。
 */
export function createDefaultRegistry(): TaskRegistry {
  return new TaskRegistry()
    .register(boxesAdapter)
    .register(occupancyAdapter)
    .register(flowAdapter)
    .register(semanticAdapter)
    .register(laneAdapter)
    .register(vlaAdapter)
}

/** 全局默认实例。测试可以自己 new 一个，互不影响 */
export const defaultTaskRegistry = createDefaultRegistry()
