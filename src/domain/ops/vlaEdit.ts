/**
 * ============================================================
 * VLA 的编辑操作
 * ============================================================
 *
 * 全部是纯函数：入参旧载荷，返回新载荷，再交给 `buildTaskPayloadCommand` 包成命令。
 *
 * 【为什么整份载荷替换，而不是细粒度的"改第 3 段的终点"命令】
 *   占据的载荷是"描述对象 + blob 引用"，细粒度改能省一次编码；
 *   VLA 的载荷本身只有几十 KB 且全在文档里，整份替换的代价就是一次 JSON 深拷贝。
 *   为它引入 5 种命令类型、还要维护"改区间时对齐关系怎么跟着动"的增量逻辑，
 *   换来的收益远小于维护成本。整份替换 = 撤销永远正确。
 *
 * 【区间编辑为什么不自动搬对齐】
 *   对齐偏移是**人标的结果**。把指令区间往后拉 10 帧，顺带把动作区间也拉 10 帧，
 *   等于把"这里确实晚了 0.6 秒"这个结论抹掉了。要搬就显式点"对齐到指令区间"。
 */
import type { Command } from '../model/command'
import type { InstructionSegment, VlaReview, VlaSign, VlaTaskData } from '../model/vla'
import { actionRangeOf, ensureAlignment } from '../model/vla'
import { buildTaskPayloadCommand } from './taskPayload'

export interface VlaEditDeps {
  label: string
  actor?: string
}

function command(before: VlaTaskData | undefined, after: VlaTaskData, deps: VlaEditDeps): Command {
  return buildTaskPayloadCommand({
    task: 'vla',
    before: before ?? null,
    after,
    label: deps.label,
    ...(deps.actor ? { actor: deps.actor } : {}),
  })
}

/** 按起点排序，让"相邻"这个概念在数组下标上也成立（规则与 UI 都依赖它） */
export function sortInstructions(vla: VlaTaskData): VlaTaskData {
  const sorted = [...vla.instructions].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)
  const same = sorted.every((s, i) => s === vla.instructions[i])
  return same ? vla : { ...vla, instructions: sorted }
}

function clampRange(start: number, end: number, lo: number, hi: number): [number, number] {
  const s = Math.min(hi, Math.max(lo, Math.round(start)))
  const e = Math.min(hi, Math.max(s, Math.round(end)))
  return [s, e]
}

/**
 * 改指令区间。
 *
 * 交叉（start > end）时交换而不是报错：拖把手的人不会去看提示文字，
 * 交换的结果就是他想要的结果。
 */
export function withInstructionRange(
  vla: VlaTaskData,
  id: string,
  start: number,
  end: number,
  docRange: [number, number],
): VlaTaskData {
  const [s, e] =
    start > end ? clampRange(end, start, docRange[0], docRange[1]) : clampRange(start, end, docRange[0], docRange[1])
  const instructions = vla.instructions.map((seg) => (seg.id === id ? { ...seg, startFrame: s, endFrame: e } : seg))
  return sortInstructions({ ...vla, instructions })
}

/**
 * 改文本。
 *
 * 改过文本的"待确认"分段视为已确认 —— 人既然改了措辞，就是看过并认可了这条。
 * 但**不**把 source 改成 manual：来源是"这句话谁先提出来的"，改措辞不改变事实。
 */
export function withInstructionText(vla: VlaTaskData, id: string, text: string): VlaTaskData {
  const instructions = vla.instructions.map((seg) => {
    if (seg.id !== id) return seg
    const review: VlaReview = seg.review === 'pending' ? 'accepted' : seg.review
    return { ...seg, text, review }
  })
  return { ...vla, instructions }
}

/** 唯一的指令 id 生成器：`ins-N`，跳过已占用的号 */
export function nextInstructionId(vla: VlaTaskData): string {
  const used = new Set(vla.instructions.map((s) => s.id))
  let n = vla.instructions.length + 1
  while (used.has(`ins-${n}`)) n++
  return `ins-${n}`
}

export function addInstruction(
  vla: VlaTaskData,
  opts: { startFrame: number; endFrame: number; text?: string; tags?: string[]; source?: InstructionSegment['source'] },
): { vla: VlaTaskData; id: string } {
  const id = nextInstructionId(vla)
  const seg: InstructionSegment = {
    id,
    text: opts.text ?? '',
    lang: 'zh',
    startFrame: opts.startFrame,
    endFrame: opts.endFrame,
    source: opts.source ?? { kind: 'manual' },
    // 新指令默认待确认：空文本本来就会被 TEXT_EMPTY 报出来，
    // 再让它"已确认"会在导出时把一条空指令带给训练侧
    review: 'pending',
    ...(opts.tags?.length ? { tags: opts.tags } : {}),
  }
  return {
    vla: sortInstructions({
      ...vla,
      instructions: [...vla.instructions, seg],
      alignment: [...vla.alignment, { instructionId: id, actionRange: [seg.startFrame, seg.endFrame] }],
    }),
    id,
  }
}

/** 删指令时**必须**一起删它的对齐关系，否则留下一条孤儿（VLA_ALIGNMENT_ORPHAN） */
export function removeInstruction(vla: VlaTaskData, id: string): VlaTaskData {
  return {
    ...vla,
    instructions: vla.instructions.filter((s) => s.id !== id),
    alignment: vla.alignment.filter((a) => a.instructionId !== id),
  }
}

export function setInstructionReview(vla: VlaTaskData, id: string, review: VlaReview): VlaTaskData {
  return { ...vla, instructions: vla.instructions.map((s) => (s.id === id ? { ...s, review } : s)) }
}

/** 全部待确认一次确认掉（复核队列里的"全接受"） */
export function acceptAllInstructions(vla: VlaTaskData): VlaTaskData {
  return {
    ...vla,
    instructions: vla.instructions.map((s) => (s.review === 'pending' ? { ...s, review: 'accepted' } : s)),
  }
}

/** 显式改对齐区间；这是唯一会移动对齐的入口 */
export function withAlignment(vla: VlaTaskData, id: string, actionRange: [number, number]): VlaTaskData {
  const exists = vla.alignment.some((a) => a.instructionId === id)
  const next = exists
    ? vla.alignment.map((a) => (a.instructionId === id ? { ...a, actionRange } : a))
    : [...vla.alignment, { instructionId: id, actionRange }]
  return { ...vla, alignment: next }
}

/** 把对齐重置回"与指令区间相同"（去掉人工标过的偏移） */
export function resetAlignment(vla: VlaTaskData, id: string): VlaTaskData {
  const seg = vla.instructions.find((s) => s.id === id)
  if (!seg) return vla
  return withAlignment(vla, id, [seg.startFrame, seg.endFrame])
}

/** 改符号约定：这是项目配置，改完要重新校验才能看到效果 */
export function withSignRule(vla: VlaTaskData, tag: string, sign: VlaSign | null): VlaTaskData {
  const signMap = { ...vla.signMap }
  if (sign === null) delete signMap[tag]
  else signMap[tag] = sign
  return { ...vla, signMap }
}

export function withHz(vla: VlaTaskData, hz: number): VlaTaskData {
  return { ...vla, hz: hz > 0 ? hz : vla.hz }
}

/** 新建一份空载荷并直接包成命令（"启用 VLA 任务"） */
export function buildCreateVlaCommand(vla: VlaTaskData, deps: VlaEditDeps): Command {
  return command(undefined, ensureAlignment(vla), deps)
}

export function buildVlaEditCommand(before: VlaTaskData, after: VlaTaskData, deps: VlaEditDeps): Command {
  return command(before, after, deps)
}

/** 清空 VLA 任务段 */
export function buildClearVlaCommand(before: VlaTaskData, deps: VlaEditDeps): Command {
  return buildTaskPayloadCommand({
    task: 'vla',
    before,
    after: null,
    label: deps.label,
    ...(deps.actor ? { actor: deps.actor } : {}),
  })
}

/** 当前帧落在哪条指令里（UI 高亮与时间线定位用） */
export function instructionAt(vla: VlaTaskData, frame: number): InstructionSegment | undefined {
  return vla.instructions.find((s) => frame >= s.startFrame && frame <= s.endFrame)
}

/** 对齐偏移（帧）。>0 表示动作比指令晚 */
export function alignmentOffset(vla: VlaTaskData, seg: InstructionSegment): number {
  const [s] = actionRangeOf(vla, seg)
  return s - seg.startFrame
}
