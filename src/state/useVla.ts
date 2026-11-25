/**
 * ============================================================
 * VLA：状态、命令、导入导出
 * ============================================================
 *
 * 【这一层只做三件事】
 *   1. 把 domain 的纯函数接到文档上（每次改动 = 一条可撤销命令）；
 *   2. 维护面板与时间线需要的派生状态（当前指令、覆盖率、校验结果）；
 *   3. 把"哪些能导出、为什么"变成状态栏能说的一句话。
 *
 * 【为什么校验结果不缓存】
 *   VLA 的载荷只有几十 KB，`validateVla` 是纯计算，11 条规则在 300 帧上
 *   不到 1ms。缓存反而要处理"哪次改动让它失效"，是纯粹的自找麻烦。
 *   占据不同 —— 那里要读 IndexedDB 解码，所以必须缓存。
 */
import { computed, ref, watch } from 'vue'
import type { StudioCore } from './studioCore'
import type { Command } from '../domain/model/command'
import type { VlaReview, VlaSign, VlaTaskData } from '../domain/model/vla'
import { createEmptyVla } from '../domain/model/vla'
import { validateVla, vlaIssueCounts, type VlaCheckOptions } from '../domain/vla/rules'
import { generateVlaDemo, type VlaDemoError } from '../domain/vla/demo'
import { parseVlaJsonl, recordToTask, vlaToJsonLine } from '../domain/io/vlaJsonl'
import {
  acceptAllInstructions, addInstruction, alignmentOffset, buildClearVlaCommand, buildCreateVlaCommand,
  buildVlaEditCommand, instructionAt, removeInstruction, resetAlignment, setInstructionReview,
  withAlignment, withHz, withInstructionRange, withInstructionText, withSignRule,
} from '../domain/ops/vlaEdit'
import { sortIssues } from '../domain/model/issue'

export interface VlaDeps {
  applyEdit: (cmd: Command) => void
  say: (msg: string) => void
  gotoFrame: (frame: number) => void
}

/** 演示注入的错误项，与面板上的开关一一对应 */
export const VLA_DEMO_ERRORS: Array<{ key: VlaDemoError; label: string; hint: string }> = [
  { key: 'gap', label: '区间空档', hint: '少 4 帧没有指令覆盖 → VLA_INSTRUCTION_GAP' },
  { key: 'overlap', label: '区间重叠', hint: '两条指令压在一起 → VLA_INSTRUCTION_OVERLAP' },
  { key: 'sign', label: '动作反向', hint: '"左转"但 steer 为正 → VLA_ACTION_SIGN' },
  { key: 'lag', label: '起转滞后', hint: '动作晚 0.8s 才开始 → VLA_ACTION_LAG' },
  { key: 'textEmpty', label: '空文本', hint: '指令只有省略号 → VLA_TEXT_EMPTY' },
  { key: 'channelLength', label: '通道少一格', hint: 'brake 比其它通道短 1 → VLA_CHANNEL_LENGTH' },
]

export function useVla(core: StudioCore, deps: VlaDeps) {
  const vla = computed<VlaTaskData | undefined>(() => {
    void core.docVersion.value
    return core.doc.value?.tasks.vla
  })

  /* ---------------- 面板与时间线的 UI 状态 ---------------- */

  const vlaSelectedId = ref<string | null>(null)
  const showVlaTimeline = ref(true)
  const vlaBusy = ref('')
  /** 通道显示开关；缺省视为开 */
  const channelOff = ref<Record<string, boolean>>({})
  const checkOptions = ref<VlaCheckOptions>({ checkTextDup: false })
  const demoErrors = ref<VlaDemoError[]>([])
  const lastImport = ref<string>('')

  const channels = computed(() => vla.value?.channels ?? [])
  const instructions = computed(() => vla.value?.instructions ?? [])

  const selected = computed(() => instructions.value.find((s) => s.id === vlaSelectedId.value) ?? null)

  /** 当前帧所在指令（时间线与面板高亮共用） */
  const currentInstruction = computed(() => {
    void core.currentFrame.value
    return vla.value ? instructionAt(vla.value, core.frameNumber()) ?? null : null
  })

  /* ---------------- 校验 ---------------- */

  const vlaIssues = computed(() => {
    void core.docVersion.value
    const payload = vla.value
    const doc = core.doc.value
    if (!payload || !doc) return []
    return sortIssues(validateVla(payload, doc, checkOptions.value))
  })

  const vlaIssueGroups = computed(() => vlaIssueCounts(vlaIssues.value))
  const vlaBlockers = computed(() => vlaIssues.value.filter((i) => i.severity === 'blocker' || i.severity === 'error').length)

  /** 覆盖率：被指令覆盖的帧数 / 样本帧数。与规则里的"空档"是同一件事的正面表述 */
  const coverage = computed(() => {
    const doc = core.doc.value
    if (!doc || !instructions.value.length) return 0
    const covered = new Set<number>()
    for (const s of instructions.value) {
      for (let f = Math.max(doc.range[0], s.startFrame); f <= Math.min(doc.range[1], s.endFrame); f++) covered.add(f)
    }
    return covered.size / Math.max(1, doc.range[1] - doc.range[0] + 1)
  })

  const pendingCount = computed(() => instructions.value.filter((s) => s.review === 'pending').length)

  /* ---------------- 命令 ---------------- */

  function commit(next: VlaTaskData, label: string): void {
    const before = vla.value
    if (!before) {
      deps.applyEdit(buildCreateVlaCommand(next, { label }))
      return
    }
    deps.applyEdit(buildVlaEditCommand(before, next, { label }))
  }

  function editRange(id: string, start: number, end: number): void {
    const cur = vla.value
    const doc = core.doc.value
    if (!cur || !doc) return
    commit(withInstructionRange(cur, id, start, end, doc.range), '调整指令区间')
  }

  function editText(id: string, text: string): void {
    const cur = vla.value
    if (!cur) return
    commit(withInstructionText(cur, id, text), '修改指令文本')
  }

  /**
   * 在"最大的空档"里加一条指令。
   * 不把新指令塞在光标处 —— 光标处多半已经有指令了，用户真正想补的是空档。
   */
  function addAtGap(): void {
    const cur = vla.value
    const doc = core.doc.value
    if (!cur || !doc) return
    const gap = largestGap(cur, doc.range)
    if (!gap) {
      deps.say('没有空档可补：指令已经覆盖全段')
      return
    }
    const { vla: next, id } = addInstruction(cur, { startFrame: gap[0], endFrame: gap[1] })
    vlaSelectedId.value = id
    commit(next, '新增指令段')
  }

  function addAtFrame(frame: number): void {
    const cur = vla.value ?? createEmptyVla(10)
    const { vla: next, id } = addInstruction(cur, { startFrame: frame, endFrame: frame })
    vlaSelectedId.value = id
    commit(next, '新增指令段')
  }

  function removeSelected(): void {
    const cur = vla.value
    const id = vlaSelectedId.value
    if (!cur || !id) return
    commit(removeInstruction(cur, id), '删除指令段')
    vlaSelectedId.value = null
  }

  function setReview(id: string, review: VlaReview): void {
    const cur = vla.value
    if (!cur) return
    commit(setInstructionReview(cur, id, review), review === 'accepted' ? '确认指令' : '拒绝指令')
  }

  function acceptAll(): void {
    const cur = vla.value
    if (!cur || !pendingCount.value) return
    commit(acceptAllInstructions(cur), `确认 ${pendingCount.value} 条指令`)
  }

  function resetAlign(id: string): void {
    const cur = vla.value
    if (!cur) return
    commit(resetAlignment(cur, id), '对齐到指令区间')
  }

  /** 把动作区间整体后移/前移 n 帧（人工对偏移的主要入口） */
  function shiftAlign(id: string, delta: number): void {
    const cur = vla.value
    const seg = cur?.instructions.find((s) => s.id === id)
    if (!cur || !seg || !delta) return
    const link = alignmentOffset(cur, seg)
    const base = seg.startFrame + link
    commit(withAlignment(cur, id, [base + delta, base + delta + (seg.endFrame - seg.startFrame)]), `对齐偏移 ${delta > 0 ? '+' : ''}${delta} 帧`)
  }

  function setHz(hz: number): void {
    const cur = vla.value
    if (!cur) return
    commit(withHz(cur, hz), `帧率设为 ${hz}Hz`)
  }

  function setSign(tag: string, sign: VlaSign): void {
    const cur = vla.value
    if (!cur) return
    commit(withSignRule(cur, tag, sign), `符号约定：${tag} → ${sign}`)
  }

  function toggleChannel(name: string): void {
    channelOff.value = { ...channelOff.value, [name]: !channelOff.value[name] }
  }

  function channelVisible(name: string): boolean {
    return !channelOff.value[name]
  }

  /* ---------------- 合成与导入导出 ---------------- */

  async function loadDemo(): Promise<void> {
    const doc = core.doc.value
    if (!doc) {
      deps.say('先加载一个数据集')
      return
    }
    vlaBusy.value = '生成 VLA 演示…'
    try {
      const payload = generateVlaDemo({ range: doc.range, hz: 10, errors: demoErrors.value })
      const before = vla.value
      if (before) {
        deps.applyEdit(buildVlaEditCommand(before, payload, { label: demoErrors.value.length ? '生成 VLA 演示（含注入错误）' : '生成 VLA 演示' }))
      } else {
        deps.applyEdit(buildCreateVlaCommand(payload, { label: '生成 VLA 演示' }))
      }
      vlaSelectedId.value = payload.instructions[0]?.id ?? null
      showVlaTimeline.value = true
      deps.say(`已生成 ${payload.instructions.length} 条指令 / ${payload.channels.length} 通道`
        + (demoErrors.value.length ? `（注入 ${demoErrors.value.length} 类错误，用于演示校验）` : '（干净数据，应为 0 问题）'))
    } finally {
      vlaBusy.value = ''
    }
  }

  function toggleDemoError(key: VlaDemoError): void {
    demoErrors.value = demoErrors.value.includes(key)
      ? demoErrors.value.filter((k) => k !== key)
      : [...demoErrors.value, key]
  }

  /**
   * 导入 JSONL。
   *
   * 只取第一条记录：一个样本一份文档，把多行塞进同一个文档会让帧号互相覆盖。
   * 多行文件请配合"每样本一个文档"的流程使用（本期不做批量建样本）。
   */
  async function importJsonl(file: File): Promise<void> {
    const doc = core.doc.value
    if (!doc) {
      deps.say('先加载一个数据集')
      return
    }
    vlaBusy.value = '解析 JSONL…'
    try {
      const text = await file.text()
      const { records, warnings } = parseVlaJsonl(text, { defaultHz: 10 })
      if (!records.length) {
        deps.say(`没有解析出任何样本行${warnings.length ? `（${warnings[0]}）` : ''}`)
        return
      }
      const payload = recordToTask(records[0], doc)
      const before = vla.value
      if (before) deps.applyEdit(buildVlaEditCommand(before, payload, { label: '导入 VLA JSONL' }))
      else deps.applyEdit(buildCreateVlaCommand(payload, { label: '导入 VLA JSONL' }))
      vlaSelectedId.value = payload.instructions[0]?.id ?? null
      showVlaTimeline.value = true
      lastImport.value = [
        `${records.length} 行`,
        `${payload.instructions.length} 条指令`,
        `${payload.channels.length} 通道`,
        ...(warnings.length ? [`${warnings.length} 条提示`] : []),
      ].join(' · ')
      deps.say(`已导入 VLA：${lastImport.value}${warnings.length ? `（首条提示：${warnings[0]}）` : ''}`)
    } catch (err) {
      deps.say(`导入失败：${(err as Error).message}`)
    } finally {
      vlaBusy.value = ''
    }
  }

  function exportJsonl(): void {
    const doc = core.doc.value
    const payload = vla.value
    if (!doc || !payload) {
      deps.say('还没有 VLA 数据可导出')
      return
    }
    const line = vlaToJsonLine(payload, doc)
    const base = (core.datasetName.value || 'sample').replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    download(`${base}-vla.jsonl`, line + '\n', 'application/x-ndjson')
    const dropped = payload.instructions.length - (JSON.parse(line) as { instructions: unknown[] }).instructions.length
    deps.say(`已导出 VLA JSONL（1 行）${dropped ? `，${dropped} 条未确认的模型指令未导出` : ''}`)
  }

  function clearVla(): void {
    const cur = vla.value
    if (!cur) {
      deps.say('当前样本没有 VLA 任务')
      return
    }
    deps.applyEdit(buildClearVlaCommand(cur, { label: '清除 VLA 任务' }))
    vlaSelectedId.value = null
    deps.say('VLA 任务已清除（可撤销）')
  }

  /* ---------------- 导航 ---------------- */

  function gotoInstruction(id: string): void {
    const seg = instructions.value.find((s) => s.id === id)
    if (!seg) return
    vlaSelectedId.value = id
    deps.gotoFrame(seg.startFrame)
  }

  function selectAtCurrentFrame(): void {
    const seg = currentInstruction.value
    if (seg) vlaSelectedId.value = seg.id
  }

  /* ---------------- 派生信息给面板用 ---------------- */

  const taskSummary = computed(() => {
    const payload = vla.value
    if (!payload) return null
    const frames = payload.channels[0]?.values.length ?? 0
    return {
      segments: payload.instructions.length,
      channels: payload.channels.length,
      frames,
      hz: payload.hz,
      /** 秒：只在展示时算，内部一律帧号 */
      seconds: payload.hz > 0 ? frames / payload.hz : 0,
    }
  })

  const alignInfo = computed(() => {
    const cur = vla.value
    const seg = selected.value
    if (!cur || !seg) return null
    const offset = alignmentOffset(cur, seg)
    return { offset, seconds: cur.hz > 0 ? offset / cur.hz : 0 }
  })

  // 换文档（或撤销到没有 VLA 的版本）时把选中项清掉，避免指向不存在的 id
  watch(instructions, (list) => {
    if (vlaSelectedId.value && !list.some((s) => s.id === vlaSelectedId.value)) vlaSelectedId.value = null
  })

  return {
    vla, vlaSelectedId, showVlaTimeline, vlaBusy, channelOff, checkOptions, demoErrors,
    channels, instructions, selected, currentInstruction,
    vlaIssues, vlaIssueGroups, vlaBlockers, coverage, pendingCount, taskSummary, alignInfo, lastImport,
    editRange, editText, addAtGap, addAtFrame, removeSelected, setReview, acceptAll,
    resetAlign, shiftAlign, setHz, setSign, toggleChannel, channelVisible,
    loadDemo, toggleDemoError, importJsonl, exportJsonl, clearVla,
    gotoInstruction, selectAtCurrentFrame,
  }
}

/** 最大的未覆盖区间；全覆盖返回 null */
export function largestGap(vla: VlaTaskData, range: [number, number]): [number, number] | null {
  const segs = [...vla.instructions].sort((a, b) => a.startFrame - b.startFrame)
  let cursor = range[0]
  let best: [number, number] | null = null
  const consider = (s: number, e: number) => {
    if (e < s) return
    if (!best || e - s > best[1] - best[0]) best = [s, e]
  }
  for (const seg of segs) {
    if (seg.startFrame > cursor) consider(cursor, seg.startFrame - 1)
    if (seg.endFrame + 1 > cursor) cursor = seg.endFrame + 1
  }
  if (cursor <= range[1]) consider(cursor, range[1])
  return best
}

function download(name: string, body: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
