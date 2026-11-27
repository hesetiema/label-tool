/**
 * ============================================================
 * VLA 对齐校验
 * ============================================================
 *
 * 【这一层和几何规则的区别】
 *   几何规则能"看见"错误：框和点云对不上，人一眼能判断。
 *   VLA 的错误看不见 —— 指令文本说"左转"，动作曲线长什么样都合理。
 *   所以这里的规则必须把"期望"显式写出来，再和"实际"比：
 *     期望 = 指令标签 + 符号约定表（项目配置，随载荷存）
 *     实际 = 通道在该区间的统计量
 *   这就是方案里"指令—动作对齐需要专门自动化校验规则"的最小实现：
 *   **不理解语言，只查符号、时长、区间与长度**。
 *
 * 【哪些规则故意没做】
 *   - VLA_WAYPOINT_COUNT：`waypoints` 没有可信数据源，做了也只能对着空数组报 0 条。
 *   - VLA_TEXT_DUP 默认关：连续两段"保持车道"很可能**是对的**，
 *     默认开会让人以为工具在乱报。留成开关，谁需要谁打开。
 *
 * 【为什么 ACTION_SMOOTH 要 hz 门禁】
 *   抖动判据是二阶差分，它的量级和采样间隔强相关。2Hz 的演示数据上
 *   二阶差分本来就大，直接判会把"采样率低"报成"控制抖动"。
 *   hz < 8 时不判，只出一条 info 说明为什么不判 —— 静默跳过等于假装查过了。
 */
import type { SampleDocument } from '../model/document'
import type { QaIssue } from '../model/issue'
import type { VlaTaskData, InstructionSegment, VlaSign } from '../model/vla'
import { makeIssue } from '../model/issue'
import { DEFAULT_VLA_SIGN_MAP, actionRangeOf, channelLastFrame, findChannel } from '../model/vla'
import { firstDeviation, mean, percentile, secondDifference } from './resample'

export interface VlaCheckOptions {
  /** 指令标签 → 期望 steer 符号；缺省用载荷自带的，再缺省用默认表 */
  signMap?: Record<string, VlaSign>
  /** |均值| 超过它才算"明确朝某个方向" */
  minAbsSteer?: number
  /** 起转滞后超过多少秒报 warn */
  lagSeconds?: number
  /** 二阶差分 95 分位超过它算抖 */
  smoothJerk?: number
  /** 低于这个帧率不判抖动 */
  minHzForSmooth?: number
  /** 起转判据：|steer| 超过它算"动了" */
  onsetEps?: number
  /** 相邻重复文本；默认关（见文件头） */
  checkTextDup?: boolean
  /** 单条规则最多报多少条，防止坏数据刷屏 */
  maxPerRule?: number
}

export const VLA_DEFAULTS = {
  minAbsSteer: 0.1,
  lagSeconds: 0.5,
  smoothJerk: 0.05,
  minHzForSmooth: 8,
  onsetEps: 0.05,
  checkTextDup: false,
  maxPerRule: 50,
} as const

/** 归一化文本：去标点与空白、英文小写。只用于比较，不改原文 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[.,;:!?'"`~(){}[\]<>，。；：！？、…—－·「」『』（）【】《》]/g, '')
}

/** 取区间内的通道采样（含端点）；同时把区间裁到通道覆盖范围内 */
function sliceChannel(vla: VlaTaskData, name: string, range: [number, number]): number[] {
  const ch = findChannel(vla, name)
  if (!ch) return []
  const lo = Math.max(range[0], ch.startFrame)
  const hi = Math.min(range[1], channelLastFrame(ch))
  if (hi < lo) return []
  return ch.values.slice(lo - ch.startFrame, hi - ch.startFrame + 1)
}

/**
 * 主入口。与 `TaskAdapter.validate` 同签名，注册表里直接挂。
 *
 * 返回的问题按规则分组推进去，顺序稳定（同输入同输出），便于测试逐条断言。
 */
export function validateVla(
  payload: VlaTaskData | undefined,
  doc: SampleDocument,
  opts: VlaCheckOptions = {},
): QaIssue[] {
  if (!payload) return []
  // 空壳（既没有指令也没有通道）= 任务已创建但还没开始。
  // 这时候报"全段 300 帧没有指令"只会让刚点开面板的人看到一屏红字，
  // 而它表达的信息量为 0。同理，注册表对 `payload === undefined` 也是直接跳过。
  if (!payload.instructions.length && !payload.channels.length) return []
  const o = { ...VLA_DEFAULTS, ...opts }
  const out: QaIssue[] = []
  const cap = (code: string) => out.filter((i) => i.code === code).length >= o.maxPerRule
  const hz = payload.hz > 0 ? payload.hz : 0
  const signMap = { ...DEFAULT_VLA_SIGN_MAP, ...(payload.signMap ?? {}), ...(opts.signMap ?? {}) }
  const range = doc.range

  /* ---------------- 指令段：区间与文本 ---------------- */

  const segs = [...payload.instructions].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)

  for (const seg of segs) {
    if (cap('VLA_INSTRUCTION_RANGE')) break
    if (seg.startFrame > seg.endFrame || seg.startFrame < range[0] || seg.endFrame > range[1]) {
      out.push(
        makeIssue({
          code: 'VLA_INSTRUCTION_RANGE',
          ruleId: 'vla.instruction.range',
          severity: 'error',
          scope: 'task',
          targets: [{ task: 'vla', frame: seg.startFrame }],
          message: `指令「${seg.text}」的区间 [${seg.startFrame}, ${seg.endFrame}] 非法或超出样本范围 [${range[0]}, ${range[1]}]`,
          fixHint: '把区间拉回样本范围内，或删掉这条指令重标',
        }),
      )
    }
  }

  for (const seg of segs) {
    if (cap('VLA_TEXT_EMPTY')) break
    if (normalizeText(seg.text).length < 2) {
      out.push(
        makeIssue({
          code: 'VLA_TEXT_EMPTY',
          ruleId: 'vla.text.empty',
          severity: 'error',
          scope: 'task',
          targets: [{ task: 'vla', frame: seg.startFrame }],
          message: `指令段 #${seg.id} 的文本为空或只有标点：「${seg.text}」`,
          fixHint: '补全指令文本；空指令会让语言侧的训练样本直接失效',
        }),
      )
    }
  }

  // 重叠：按起点排序后，只看相邻两条即可覆盖全部相交对（区间图的性质）
  let prev: InstructionSegment | null = null
  for (const seg of segs) {
    if (prev && seg.startFrame <= prev.endFrame && !cap('VLA_INSTRUCTION_OVERLAP')) {
      out.push(
        makeIssue({
          code: 'VLA_INSTRUCTION_OVERLAP',
          ruleId: 'vla.instruction.overlap',
          severity: 'error',
          scope: 'task',
          targets: [{ task: 'vla', frame: seg.startFrame }],
          value: prev.endFrame - seg.startFrame + 1,
          message: `指令段 #${prev.id} 与 #${seg.id} 重叠 ${prev.endFrame - seg.startFrame + 1} 帧（${seg.startFrame}–${prev.endFrame}）`,
          fixHint: '一条指令只能覆盖一个区间：改一条的端点，或删掉多余的',
        }),
      )
    }
    if (!prev || seg.endFrame > prev.endFrame) prev = seg
  }

  // 空档：区间并集是否覆盖全样本
  let cursor = range[0]
  for (const seg of segs) {
    if (cap('VLA_INSTRUCTION_GAP')) break
    if (seg.startFrame > cursor) {
      out.push(
        makeIssue({
          code: 'VLA_INSTRUCTION_GAP',
          ruleId: 'vla.instruction.gap',
          severity: 'warn',
          scope: 'task',
          targets: [{ task: 'vla', frame: cursor }],
          value: seg.startFrame - cursor,
          message: `第 ${cursor}–${seg.startFrame - 1} 帧（${seg.startFrame - cursor} 帧）没有指令覆盖`,
          fixHint: '补一条"保持行驶"之类的指令，或把相邻指令的区间拉过来',
        }),
      )
    }
    if (seg.endFrame + 1 > cursor) cursor = seg.endFrame + 1
  }
  if (!cap('VLA_INSTRUCTION_GAP') && cursor <= range[1]) {
    out.push(
      makeIssue({
        code: 'VLA_INSTRUCTION_GAP',
        ruleId: 'vla.instruction.gap',
        severity: 'warn',
        scope: 'task',
        targets: [{ task: 'vla', frame: cursor }],
        value: range[1] - cursor + 1,
        message: `末尾第 ${cursor}–${range[1]} 帧（${range[1] - cursor + 1} 帧）没有指令覆盖`,
        fixHint: '补一条收尾指令，或把最后一段的区间拉到样本末尾',
      }),
    )
  }

  if (o.checkTextDup) {
    for (let i = 1; i < segs.length; i++) {
      if (cap('VLA_TEXT_DUP')) break
      if (normalizeText(segs[i].text) && normalizeText(segs[i].text) === normalizeText(segs[i - 1].text)) {
        out.push(
          makeIssue({
            code: 'VLA_TEXT_DUP',
            ruleId: 'vla.text.dup',
            severity: 'warn',
            scope: 'task',
            targets: [{ task: 'vla', frame: segs[i].startFrame }],
            message: `指令段 #${segs[i - 1].id} 与 #${segs[i].id} 文本完全相同：「${segs[i].text}」`,
            fixHint: '确认是不是该合成一段；若确实是两次独立指令（如两次"保持车道"），可以忽略',
          }),
        )
      }
    }
  }

  /* ---------------- 通道：长度与数值 ---------------- */

  const channels = payload.channels
  if (channels.length) {
    const first = channels[0]
    for (const ch of channels) {
      if (cap('VLA_CHANNEL_LENGTH')) break
      if (!ch.values.length) {
        out.push(
          makeIssue({
            code: 'VLA_CHANNEL_LENGTH',
            ruleId: 'vla.channel.length',
            severity: 'blocker',
            scope: 'task',
            targets: [{ task: 'vla', frame: ch.startFrame }],
            message: `通道 ${ch.name} 没有任何采样值`,
            fixHint: '删掉空通道，或重新导入该通道数据',
          }),
        )
        continue
      }
      const last = channelLastFrame(ch)
      if (last > range[1]) {
        out.push(
          makeIssue({
            code: 'VLA_CHANNEL_LENGTH',
            ruleId: 'vla.channel.length',
            severity: 'blocker',
            scope: 'task',
            targets: [{ task: 'vla', frame: range[1] }],
            value: last - range[1],
            message: `通道 ${ch.name} 覆盖到第 ${last} 帧，超出样本末帧 ${range[1]}（多 ${last - range[1]} 个采样）`,
            fixHint: '采样率与帧率不匹配：按 hz 重采样，或裁掉多余部分',
          }),
        )
      }
      // 通道之间必须同起点同长度，否则"第 i 个采样"在不同通道上不是同一帧
      if (ch !== first && (ch.startFrame !== first.startFrame || ch.values.length !== first.values.length)) {
        out.push(
          makeIssue({
            code: 'VLA_CHANNEL_LENGTH',
            ruleId: 'vla.channel.length',
            severity: 'blocker',
            scope: 'task',
            targets: [{ task: 'vla', frame: ch.startFrame }],
            value: ch.values.length - first.values.length,
            message: `通道 ${ch.name}（起点 ${ch.startFrame}、${ch.values.length} 个值）与 ${first.name}（起点 ${first.startFrame}、${first.values.length} 个值）不一致`,
            fixHint: '逐帧对齐要求所有通道覆盖同一区间：统一重采样到样本帧率',
          }),
        )
      }
    }

    for (const ch of channels) {
      if (cap('VLA_CHANNEL_FINITE')) break
      const bad = ch.values.findIndex((v) => !Number.isFinite(v))
      if (bad >= 0) {
        out.push(
          makeIssue({
            code: 'VLA_CHANNEL_FINITE',
            ruleId: 'vla.channel.finite',
            severity: 'blocker',
            scope: 'task',
            targets: [{ task: 'vla', frame: ch.startFrame + bad }],
            message: `通道 ${ch.name} 第 ${ch.startFrame + bad} 帧的值不是有限数（${String(ch.values[bad])}）`,
            fixHint: 'JSON 里的 null/字符串会变成 NaN：导入时补成 0 或删掉该帧',
          }),
        )
      }
    }
  }

  /* ---------------- 对齐与跨模态 ---------------- */

  const instructionIds = new Set(payload.instructions.map((s) => s.id))
  for (const link of payload.alignment) {
    if (cap('VLA_ALIGNMENT_ORPHAN')) break
    if (!instructionIds.has(link.instructionId)) {
      out.push(
        makeIssue({
          code: 'VLA_ALIGNMENT_ORPHAN',
          ruleId: 'vla.alignment.orphan',
          severity: 'error',
          scope: 'task',
          targets: [{ task: 'vla' }],
          message: `对齐关系指向不存在的指令 #${link.instructionId}`,
          fixHint: '删掉这条对齐，或补回被删的指令（多半是删指令时忘了清对齐）',
        }),
      )
    }
  }

  const hasSteer = !!findChannel(payload, 'steer')

  for (const seg of segs) {
    if (cap('VLA_ACTION_SIGN')) break
    const tags = seg.tags ?? []
    // 只认第一条能查到期望的标签：一条指令同时挂 'lane-change' 与 'turn-left' 时，
    // 两者对 steer 的期望是同一个方向，取哪条都不影响结果；但把"停"和"左转"混挂时
    // 就矛盾了，那种情况交给人工判断，规则不猜
    const tag = tags.find((t) => signMap[t] && signMap[t] !== 'zero')
    if (!tag || !hasSteer) continue
    const ar = actionRangeOf(payload, seg)
    const steer = sliceChannel(payload, 'steer', ar)
    if (steer.length < 3) continue
    const m = mean(steer)
    const expect = signMap[tag]
    const signOk = expect === 'negative' ? m < 0 : m > 0
    if (!signOk && Math.abs(m) > o.minAbsSteer) {
      out.push(
        makeIssue({
          code: 'VLA_ACTION_SIGN',
          ruleId: 'vla.action.sign',
          severity: 'error',
          scope: 'crossTask',
          targets: [{ task: 'vla', frame: ar[0] }],
          value: m,
          threshold: o.minAbsSteer,
          message: `指令「${seg.text}」标为 ${tag}（期望 steer ${expect === 'negative' ? '< 0' : '> 0'}），实测该区间均值 ${m.toFixed(3)}`,
          fixHint: '三种可能：指令文本错了、动作区间没对齐、或符号约定与该数据集相反（改 signMap）',
        }),
      )
    }
  }

  // 停车：期望刹车踩下去
  for (const seg of segs) {
    if (cap('VLA_ACTION_SIGN')) break
    if (!(seg.tags ?? []).includes('stop')) continue
    const brake = sliceChannel(payload, 'brake', actionRangeOf(payload, seg))
    if (brake.length < 3) continue
    const m = mean(brake)
    if (m < 0.3) {
      out.push(
        makeIssue({
          code: 'VLA_ACTION_SIGN',
          ruleId: 'vla.action.sign',
          severity: 'error',
          scope: 'crossTask',
          targets: [{ task: 'vla', frame: seg.startFrame }],
          value: m,
          threshold: 0.3,
          message: `指令「${seg.text}」标为停车，但该区间刹车均值为 ${m.toFixed(3)}（阈值 0.3）`,
          fixHint: '确认是真停车还是"减速通过"；若动作对，改指令文本',
        }),
      )
    }
  }

  // 滞后：动作开始晚于指令开始
  if (hz > 0 && hasSteer) {
    for (const seg of segs) {
      if (cap('VLA_ACTION_LAG')) break
      const ar = actionRangeOf(payload, seg)
      const ch = findChannel(payload, 'steer')!
      const lo = Math.max(ar[0], ch.startFrame)
      const hi = Math.min(ar[1], channelLastFrame(ch))
      if (hi - lo < 3) continue
      const window = ch.values.slice(lo - ch.startFrame, hi - ch.startFrame + 1)
      const idx = firstDeviation(window, 0, o.onsetEps)
      if (idx < 0) continue // 全程没动：那是 SIGN 或文本的问题，不是滞后
      const lag = (lo + idx - ar[0]) / hz
      if (lag > o.lagSeconds) {
        out.push(
          makeIssue({
            code: 'VLA_ACTION_LAG',
            ruleId: 'vla.action.lag',
            severity: 'warn',
            scope: 'crossTask',
            targets: [{ task: 'vla', frame: ar[0] }],
            value: lag,
            threshold: o.lagSeconds,
            message: `指令「${seg.text}」起于第 ${ar[0]} 帧，动作到第 ${lo + idx} 帧才动（滞后 ${lag.toFixed(2)}s）`,
            fixHint: '若指令确实提前发出，把动作区间前移；若是自动对齐的，手工对一次更准',
          }),
        )
      }
    }
  }

  // 抖动：低采样率下不判，只说明为什么不判
  if (hasSteer) {
    const ch = findChannel(payload, 'steer')!
    if (!hz || hz < o.minHzForSmooth) {
      out.push(
        makeIssue({
          code: 'VLA_ACTION_SMOOTH',
          ruleId: 'vla.action.smooth',
          severity: 'info',
          scope: 'task',
          targets: [{ task: 'vla' }],
          value: hz,
          threshold: o.minHzForSmooth,
          message: hz
            ? `帧率 ${hz}Hz 低于 ${o.minHzForSmooth}Hz，抖动检查已跳过（二阶差分量级不可比）`
            : '载荷没有有效 hz，抖动检查已跳过',
          fixHint: '导入时填上真实帧率（hz），或在数据集侧提高采样率',
        }),
      )
    } else {
      const d2 = secondDifference(ch.values)
      const p95 = percentile(d2, 0.95)
      if (p95 > o.smoothJerk) {
        out.push(
          makeIssue({
            code: 'VLA_ACTION_SMOOTH',
            ruleId: 'vla.action.smooth',
            severity: 'warn',
            scope: 'task',
            targets: [{ task: 'vla', frame: ch.startFrame }],
            value: p95,
            threshold: o.smoothJerk,
            message: `steer 二阶差分 95 分位 ${p95.toFixed(4)}，超过 ${o.smoothJerk}`,
            fixHint: '先确认不是逐帧独立采集造成的锯齿；是的话在通道上做一次平滑',
          }),
        )
      }
    }
  }

  return out
}

/** 一致性汇总用：按规则分组计数 */
export function vlaIssueCounts(
  issues: readonly QaIssue[],
): Array<{ code: string; count: number; severity: QaIssue['severity'] }> {
  const map = new Map<string, { count: number; severity: QaIssue['severity'] }>()
  const order: Record<QaIssue['severity'], number> = { blocker: 0, error: 1, warn: 2, info: 3 }
  for (const i of issues) {
    const cur = map.get(i.code)
    if (cur) {
      cur.count++
      if (order[i.severity] < order[cur.severity]) cur.severity = i.severity
    } else {
      map.set(i.code, { count: 1, severity: i.severity })
    }
  }
  return [...map.entries()]
    .map(([code, v]) => ({ code, count: v.count, severity: v.severity }))
    .sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count)
}
