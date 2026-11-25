/**
 * ============================================================
 * VLA 的 JSONL 读写
 * ============================================================
 *
 * 一行一个样本。选 JSONL 而不是单个 JSON 数组，是因为 VLA 数据集动辄几万条，
 * 流式读写比"整份 parse 进内存"现实；另一个好处是坏一行只影响一行。
 *
 * 【对外字段用 snake_case】
 *   训练侧（Python）按 snake_case 写，仓库内部按 camelCase 存。
 *   两者只在这一层换算 —— 让内部跟着外部改，会污染整条链。
 *
 * 【容错取向：宁可留下可疑数据让规则去报，不要静默丢弃】
 *   - `null` / 字符串数字：转成 NaN，让 VLA_CHANNEL_FINITE 报出来。
 *     静默转成 0 是最坏的选择：数据看着正常，训练时才发作。
 *   - 缺 hz：用默认值填，但记录一条 warning 一起返回，由调用方决定要不要提示。
 *   - 行解析失败：跳过该行，收集错误行号，不中断整个文件。
 */
import type { SampleDocument } from '../model/document'
import type { ActionChannel, ChannelUnit, VlaTaskData, InstructionSegment } from '../model/vla'
import { DEFAULT_VLA_SIGN_MAP } from '../model/vla'
import { isExportableState } from '../ops/review'

export interface VlaJsonRecord {
  sampleId?: string
  hz: number
  instructions: InstructionSegment[]
  channels: ActionChannel[]
}

export interface VlaParseResult {
  records: VlaJsonRecord[]
  /** 解析期的问题（不是标注问题），例如"第 3 行不是 JSON" */
  warnings: string[]
}

const UNIT_BY_NAME: Record<string, ChannelUnit> = {
  steer: 'norm',
  throttle: 'norm',
  brake: 'norm',
  speed: 'm/s',
  acceleration: 'm/s2',
  yaw_rate: 'rad',
}

/** 数值字段：只接受有限数字，其余一律 NaN（留给规则报，不要悄悄变 0） */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN
}

function pick<T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T
  }
  return undefined
}

function toFrames(obj: Record<string, unknown>): [number, number] {
  const s = Number(pick<number>(obj, 'start_frame', 'startFrame', 'start') ?? 0)
  const e = Number(pick<number>(obj, 'end_frame', 'endFrame', 'end') ?? s)
  return [Number.isFinite(s) ? s : 0, Number.isFinite(e) ? e : s]
}

function toInstruction(raw: unknown, index: number): InstructionSegment | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const text = typeof obj.text === 'string' ? obj.text : ''
  const [startFrame, endFrame] = toFrames(obj)
  const tags = Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string') : undefined
  return {
    id: typeof obj.id === 'string' && obj.id ? obj.id : `ins-${index + 1}`,
    text,
    lang: obj.lang === 'en' ? 'en' : 'zh',
    startFrame,
    endFrame,
    // 外来数据一律算 import；模型产出的分段由上层把它改成 model + pending
    source: { kind: 'import' },
    review: 'none',
    ...(tags?.length ? { tags } : {}),
  }
}

function toChannel(name: string, raw: unknown, defaultStart: number): ActionChannel | null {
  let values: unknown
  let startFrame = defaultStart
  let unit: ChannelUnit | undefined
  let sourceHz = 0
  if (Array.isArray(raw)) {
    values = raw
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    values = pick<unknown[]>(obj, 'values', 'data', 'v')
    const s = Number(pick<number>(obj, 'start_frame', 'startFrame') ?? defaultStart)
    if (Number.isFinite(s)) startFrame = s
    const u = pick<string>(obj, 'unit')
    if (u) unit = u as ChannelUnit
    const hz = Number(pick<number>(obj, 'source_hz', 'sourceHz', 'hz') ?? 0)
    if (Number.isFinite(hz) && hz > 0) sourceHz = hz
  }
  if (!Array.isArray(values)) return null
  return {
    name,
    unit: unit ?? UNIT_BY_NAME[name] ?? 'norm',
    values: values.map(num),
    startFrame,
    // 0 表示"文件没说"，由 parseVlaJsonl 回填成文件声明的 hz
    sourceHz,
  }
}

/**
 * 解析 JSONL。
 *
 * 兼容两种通道写法：
 *   `"actions": { "steer": [0.1, 0.2, ...] }`
 *   `"actions": [ { "name": "steer", "values": [...], "unit": "norm" } ]`
 */
export function parseVlaJsonl(text: string, opts: { defaultHz?: number } = {}): VlaParseResult {
  const warnings: string[] = []
  const records: VlaJsonRecord[] = []
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      warnings.push(`第 ${i + 1} 行不是合法 JSON，已跳过`)
      continue
    }

    const hzRaw = Number(pick<number>(obj, 'hz', 'fps', 'frame_rate') ?? 0)
    const hz = Number.isFinite(hzRaw) && hzRaw > 0 ? hzRaw : (opts.defaultHz ?? 10)
    if (!(hzRaw > 0)) warnings.push(`第 ${i + 1} 行没有有效 hz，按 ${hz}Hz 处理`)

    const rawIns = (pick<unknown[]>(obj, 'instructions', 'segments') ?? [])
    const instructions = rawIns
      .map((r, k) => toInstruction(r, k))
      .filter((s): s is InstructionSegment => !!s)
    if (!instructions.length) warnings.push(`第 ${i + 1} 行没有指令段`)

    const rawActions = pick<unknown>(obj, 'actions', 'channels') ?? {}
    let channels: ActionChannel[] = []
    const start = instructions.length ? Math.min(...instructions.map((s) => s.startFrame)) : 0
    if (Array.isArray(rawActions)) {
      for (const [k, item] of rawActions.entries()) {
        if (!item || typeof item !== 'object') continue
        const o = item as Record<string, unknown>
        const name = typeof o.name === 'string' ? o.name : `ch${k}`
        const ch = toChannel(name, o, start)
        if (ch) channels.push(ch)
      }
    } else if (rawActions && typeof rawActions === 'object') {
      for (const [name, value] of Object.entries(rawActions as Record<string, unknown>)) {
        const ch = toChannel(name, value, start)
        if (ch) channels.push(ch)
      }
    }
    // sourceHz 统一回填成文件声明的 hz：外来值不可靠，但"它自称多少 Hz"要留下
    channels = channels.map((c) => ({ ...c, sourceHz: c.sourceHz || hz }))

    records.push({
      sampleId: typeof obj.sample_id === 'string' ? obj.sample_id : undefined,
      hz,
      instructions,
      channels,
    })
  }

  return { records, warnings }
}

/**
 * 把解析结果套到当前样本上。
 *
 * 【为什么要传 doc】帧号必须落进样本范围。记录里的帧号是"另一份切分"，
 * 直接塞进文档会得到一堆越界区间 —— 那正是 VLA_INSTRUCTION_RANGE 要报的情况，
 * 但由导入层主动对齐比让用户看到 20 条红字更好。
 */
export function recordToTask(record: VlaJsonRecord, doc: SampleDocument): VlaTaskData {
  const [lo, hi] = doc.range
  const shift = record.instructions.length ? Math.min(...record.instructions.map((s) => s.startFrame)) - lo : 0
  const move = (f: number) => Math.min(hi, Math.max(lo, f - shift))
  const instructions = record.instructions.map((s) => ({
    ...s,
    startFrame: move(s.startFrame),
    endFrame: move(s.endFrame),
  }))
  return {
    instructions,
    channels: record.channels.map((c) => ({ ...c, startFrame: move(c.startFrame) })),
    alignment: instructions.map((s) => ({ instructionId: s.id, actionRange: [s.startFrame, s.endFrame] as [number, number] })),
    hz: record.hz,
    signMap: { ...DEFAULT_VLA_SIGN_MAP },
    source: { kind: 'import' },
  }
}

/**
 * 导出一行 JSONL。
 *
 * 导出闸门复用 P2 的 `isExportableState`：模型产出且未确认的指令**不出**。
 * 这样"不把 LLM 生成当标注"和框的规则是同一条，不需要在两处各写一遍。
 */
export function vlaToJsonLine(vla: VlaTaskData, doc: SampleDocument): string {
  const kept = vla.instructions.filter((s) => isExportableState(s))
  const keptIds = new Set(kept.map((s) => s.id))
  const actions: Record<string, unknown> = {}
  for (const ch of vla.channels) {
    actions[ch.name] = { unit: ch.unit, start_frame: ch.startFrame, values: ch.values }
  }
  return JSON.stringify({
    sample_id: String(doc.sampleId),
    hz: vla.hz,
    range: doc.range,
    instructions: kept.map((s) => ({
      id: s.id,
      text: s.text,
      lang: s.lang,
      start_frame: s.startFrame,
      end_frame: s.endFrame,
      ...(s.tags?.length ? { tags: s.tags } : {}),
    })),
    actions,
    // 对齐关系只导出仍然存在的那几条，避免回读时变成孤儿
    alignment: vla.alignment
      .filter((a) => keptIds.has(a.instructionId))
      .map((a) => ({ instruction_id: a.instructionId, action_range: a.actionRange })),
    dropped: vla.instructions.length - kept.length || undefined,
  })
}
