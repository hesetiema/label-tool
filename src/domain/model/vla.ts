/**
 * ============================================================
 * VlaTaskData —— 语言—动作对齐
 * ============================================================
 *
 * 【它要表达什么】
 *   一条自然语言指令，在帧区间上覆盖一段行为；同一区间里有一组逐帧控制量。
 *   这两者之间的**对应关系本身**是标注结果，不是派生结果 ——
 *   文本说"前方路口左转"，实际起转可能晚 0.6 秒，这个偏移要能标、能改、能校验。
 *
 * 【为什么 values 是 number[] 而不是 Float32Array】
 *   方案 5.4.1 定的是 Float32Array，理由是内存与遍历。但那一条与 5.4.5
 *   "导出 JSONL" 直接冲突：IndexedDB 的结构化克隆能存 TypedArray，
 *   `applyCommand` 的 structuredClone 也能，可导出走的是 JSON.stringify，
 *   Float32Array 会序列化成 `{"0":1.2,"1":…}` —— 不是数组，Python 侧读不了。
 *   本仓库已经踩过一次同类坑（`Track.states` 是 Map，见 indexedDbStore.ts 的注释）。
 *
 *   300 帧 × 4 通道 = 1200 个数，JSON 约 10KB。为了省 4.8KB 内存换来
 *   "导出要额外转一次、且转了才正确"，不划算。绘制时按需转一次 Float32Array 即可。
 *
 * 【为什么 hz 存在载荷里而不是全局常量】
 *   `core/sequence/temporalQA.ts` 用固定 `dt = 0.5` 算速度（假定 2Hz），
 *   而 IO 层知道真实帧率（`frameCloudStore` 写死 nominalHz: 10）。
 *   两个数字对不上，谁都不该被当成"系统的帧率"。
 *   VLA 的规则要用秒（滞后 0.5s），所以把 hz 显式存在这份载荷上：
 *   内部一律用帧号，秒只在规则判定与导出边界换算。
 */
import type { ObservationState, SourceTag } from './track'

/** 四个标准通道；允许自定义名字（不同数据集有额外控制量） */
export type ChannelName = 'steer' | 'throttle' | 'brake' | 'speed'

export const STANDARD_CHANNELS: readonly ChannelName[] = ['steer', 'throttle', 'brake', 'speed']

export type ChannelUnit = 'norm' | 'rad' | 'deg' | 'm/s' | 'm/s2'

export type VlaLang = 'zh' | 'en'

/** 复用轨迹的复核状态，不另造一套 */
export type VlaReview = ObservationState['review']

export interface InstructionSegment {
  id: string
  /** 自然语言原文；不做任何归一化，归一化只在比较时做 */
  text: string
  lang: VlaLang
  /** 闭区间，帧号基于样本文档，不基于秒 */
  startFrame: number
  endFrame: number
  source: SourceTag
  /**
   * 人工确认后才算数。LLM 分段默认 pending —— 导出闸门复用 P2 的判据
   * （`isExportableView`），所以"不把 LLM 生成当标注"不是靠自觉。
   */
  review: VlaReview
  /** 语义标签，例如 'turn-left' / 'lane-change-right' / 'stop'；动作符号校验靠它 */
  tags?: string[]
}

export interface ActionChannel {
  name: ChannelName | string
  unit: ChannelUnit
  /**
   * 逐帧采样。长度与 `startFrame` 一起决定覆盖范围，
   * 不另存 endFrame —— 两个字段能表达同一件事时，只留一个。
   */
  values: number[]
  startFrame: number
  /** 原始采样率。重采样到样本帧率后写回 values，这里留痕以便追溯 */
  sourceHz: number
}

/**
 * 指令 → 动作区间的对应。
 * 缺省由编辑层补成"与指令区间相同"，只有人工改过才会不同。
 */
export interface AlignmentLink {
  instructionId: string
  actionRange: [number, number]
  /** 对齐质量 0..1，用于排序复核；人工确认过的对齐不填 */
  score?: number
}

export interface VlaTaskData {
  instructions: InstructionSegment[]
  channels: ActionChannel[]
  alignment: AlignmentLink[]
  /**
   * 可选：专家轨迹/航点，扁平 `[x, y] × N`（自车坐标系，米）。
   * 方案里的 VLA_WAYPOINT_COUNT 依赖它，本期没有可信数据源，字段先留、规则不做。
   */
  waypoints?: number[]
  /** 样本帧率（Hz）。内部一律帧号，秒只在规则与导出边界换算 */
  hz: number
  /** 指令标签 → 期望 steer 符号。不同数据集正负相反，所以随载荷存 */
  signMap: Record<string, VlaSign>
  source: SourceTag
}

export type VlaSign = 'positive' | 'negative' | 'zero'

/**
 * 默认符号约定：左转 steer < 0、右转 steer > 0、停车 brake 大且速度趋零。
 *
 * 这是**项目配置**，不是普适真理 —— 有的数据集左转为正。
 * 写死会在真实数据上全量误报，所以它跟着载荷走，可在面板里改。
 */
export const DEFAULT_VLA_SIGN_MAP: Record<string, VlaSign> = {
  'turn-left': 'negative',
  'turn-right': 'positive',
  'lane-change-left': 'negative',
  'lane-change-right': 'positive',
  'u-turn': 'negative',
  stop: 'zero',
}

export function createEmptyVla(hz = 10): VlaTaskData {
  return {
    instructions: [],
    channels: [],
    alignment: [],
    hz,
    signMap: { ...DEFAULT_VLA_SIGN_MAP },
    source: { kind: 'manual' },
  }
}

/** 通道覆盖的最后一帧（含）。空通道返回 startFrame - 1，便于"覆盖不到任何帧"的判断 */
export function channelLastFrame(ch: ActionChannel): number {
  return ch.startFrame + Math.max(0, ch.values.length) - 1
}

/** 某帧的通道值；越界返回 null，不要返回 0 —— 0 是一个合法的控制量 */
export function channelAt(ch: ActionChannel, frame: number): number | null {
  const i = frame - ch.startFrame
  if (i < 0 || i >= ch.values.length) return null
  return ch.values[i]
}

/** 按名字找通道 */
export function findChannel(vla: VlaTaskData, name: string): ActionChannel | undefined {
  return vla.channels.find((c) => c.name === name)
}

/** 指令的动作区间：有对齐用对齐，没有就退回指令自身区间 */
export function actionRangeOf(vla: VlaTaskData, seg: InstructionSegment): [number, number] {
  const link = vla.alignment.find((a) => a.instructionId === seg.id)
  return link ? link.actionRange : [seg.startFrame, seg.endFrame]
}

/**
 * 补全对齐关系。
 *
 * 编辑指令区间后如果要调用它，注意语义：**只在缺失时补默认值，不覆盖已有对齐**。
 * 已有对齐是人工标过的偏移，被区间编辑顺带改掉就等于把标注抹了。
 */
export function ensureAlignment(vla: VlaTaskData): VlaTaskData {
  const known = new Set(vla.alignment.map((a) => a.instructionId))
  const missing = vla.instructions.filter((s) => !known.has(s.id))
  if (!missing.length) return vla
  return {
    ...vla,
    alignment: [
      ...vla.alignment,
      ...missing.map((s) => ({ instructionId: s.id, actionRange: [s.startFrame, s.endFrame] as [number, number] })),
    ],
  }
}
