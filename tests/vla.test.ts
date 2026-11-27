/**
 * P4 测试 —— VLA 语言—动作对齐（不需要浏览器）
 *   pnpm test -- vla
 *
 * 覆盖五块纯逻辑：
 *   1. 重采样与统计：线性重采样、分位数、二阶差分、归一
 *   2. 合成数据：确定性、干净基线零问题、注入错误只报对应码
 *   3. 十条规则：该报时报、不该报时不报，以及各条规则的边界
 *   4. 编辑操作：区间交叉、文本改判、删指令不留孤儿
 *   5. JSONL 读写与命令接线：往返一致、容错、导出闸门
 *
 * 为什么这些能脱离浏览器测：
 *   校验是"载荷 + 文档"的纯函数，编辑是纯函数，JSONL 是字符串进出。
 *   曲线绘制与时间线联动属于 UI，由 `scripts/browser/vla.mjs` 走查。
 */
import { it } from 'vitest'
import { createChecker } from './harness.ts'
import { createEmptyDocument } from '../src/domain/model/document.ts'
import type { SampleDocument } from '../src/domain/model/document.ts'
import { createDefaultRegistry } from '../src/domain/model/task.ts'
import {
  actionRangeOf,
  channelAt,
  channelLastFrame,
  createEmptyVla,
  ensureAlignment,
  type VlaTaskData,
} from '../src/domain/model/vla.ts'
import { generateVlaDemo, type VlaDemoError } from '../src/domain/vla/demo.ts'
import { validateVla } from '../src/domain/vla/rules.ts'
import {
  firstDeviation,
  mean,
  normalize01,
  percentile,
  resampleLinear,
  secondDifference,
  smoothExponential,
} from '../src/domain/vla/resample.ts'
import {
  acceptAllInstructions,
  addInstruction,
  alignmentOffset,
  buildClearVlaCommand,
  buildCreateVlaCommand,
  buildVlaEditCommand,
  instructionAt,
  nextInstructionId,
  removeInstruction,
  resetAlignment,
  setInstructionReview,
  withAlignment,
  withInstructionRange,
  withInstructionText,
  withSignRule,
} from '../src/domain/ops/vlaEdit.ts'
import { parseVlaJsonl, recordToTask, vlaToJsonLine } from '../src/domain/io/vlaJsonl.ts'
import { commandBlobRefs } from '../src/domain/store/blobRefs.ts'

const { check, finish } = createChecker()

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code)
const has = (issues: Array<{ code: string }>, code: string) => codes(issues).includes(code)

const RANGE: [number, number] = [0, 299]
function mkDoc(range: [number, number] = RANGE): SampleDocument {
  return createEmptyDocument({ sampleId: 'vla#0-299', sceneId: 'vla', range })
}
function demo(errors: VlaDemoError[] = [], seed = 20261125): VlaTaskData {
  return generateVlaDemo({ range: RANGE, hz: 10, seed, errors })
}
function validate(payload: VlaTaskData, doc = mkDoc(), opts = {}) {
  return validateVla(payload, doc, opts)
}

/* ==================================================================
 * 1. 重采样与统计
 * ================================================================== */
console.log('\n[1] 重采样与统计')

check('同频重采样原样返回', resampleLinear([1, 2, 3], 10, 10).join() === '1,2,3')
check(
  '20Hz → 10Hz 长度减半',
  resampleLinear(
    new Array(20).fill(0).map((_, i) => i),
    20,
    10,
  ).length === 10,
)
{
  // 重采样按"时长"对齐：1Hz 的 2 个采样等价于 2 秒，换到 3Hz 应该是 6 个采样
  const up = resampleLinear([0, 10], 1, 3)
  check('1Hz → 3Hz 端点保持', near(up[0], 0) && near(up[up.length - 1], 10), up.join())
  check('1Hz → 3Hz 按比例生成 6 个采样', up.length === 6, up.join())
  check('1Hz → 3Hz 中间是线性插值', near(up[1], 2) && near(up[3], 6), up.join())
}
check('空数组重采样返回空', resampleLinear([], 10, 10).length === 0)
check('非法频率不炸、原样返回', resampleLinear([1, 2], 0, 10).join() === '1,2')

check('percentile 0.95 落在末段', near(percentile([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 1), 9))
check('percentile 空数组为 0', percentile([], 0.5) === 0)
check('mean 正常', near(mean([1, 2, 3]), 2))
check('mean 空数组为 0（调用方不该用 0 当哨兵）', mean([]) === 0)

check(
  '二阶差分：线性序列全 0',
  secondDifference([1, 2, 3, 4, 5]).every((v) => v === 0),
)
check('二阶差分：锯齿被放大', secondDifference([0, 1, 0, 1, 0])[0] > 1)
check('二阶差分：少于 3 点返回空', secondDifference([1, 2]).length === 0)

check(
  'normalize01 常量通道返回 0.5 而不是 0',
  normalize01([3, 3, 3]).every((v) => v === 0.5),
)
check('normalize01 端点 0/1', normalize01([2, 4])[0] === 0 && normalize01([2, 4])[1] === 1)
check('firstDeviation 找到第一次越过阈值的位置', firstDeviation([0, 0, 0.2, 0.4], 0, 0.05) === 2)
check('firstDeviation 全程不动返回 -1', firstDeviation([0, 0, 0.01], 0, 0.05) === -1)
check(
  '指数平滑保留长度且首值不变',
  (() => {
    const s = smoothExponential([1, 5, 5, 5], 0.5)
    return s.length === 4 && s[0] === 1 && s[3] > 1 && s[3] < 5
  })(),
)

/* ==================================================================
 * 2. 合成数据
 * ================================================================== */
console.log('\n[2] 合成数据')

{
  const d = demo()
  check('默认生成 5 条指令 / 4 通道', d.instructions.length === 5 && d.channels.length === 4)
  check(
    '指令恰好铺满全段（首尾对齐）',
    d.instructions[0].startFrame === RANGE[0] && d.instructions[d.instructions.length - 1].endFrame === RANGE[1],
    `${d.instructions[0].startFrame}..${d.instructions[4].endFrame}`,
  )
  check(
    '相邻指令首尾相接（无缝无叠）',
    d.instructions.every((s, i) => i === 0 || s.startFrame === d.instructions[i - 1].endFrame + 1),
  )
  check(
    '通道长度 = 帧数',
    d.channels.every((c) => c.values.length === 300),
  )
  check(
    '通道同起点',
    d.channels.every((c) => c.startFrame === RANGE[0]),
  )
  check('hz 写进载荷', d.hz === 10)
  check(
    '对齐默认等于指令区间',
    d.alignment.length === 5 &&
      d.alignment.every((a) => {
        const seg = d.instructions.find((s) => s.id === a.instructionId)!
        return a.actionRange[0] === seg.startFrame && a.actionRange[1] === seg.endFrame
      }),
  )
  check('确定性：同 seed 同结果', JSON.stringify(demo([], 7)) === JSON.stringify(demo([], 7)))
  check(
    '换 seed 仍满足"铺满"这条硬约束',
    (() => {
      const other = demo([], 99)
      return other.instructions[0].startFrame === RANGE[0] && other.instructions[4].endFrame === RANGE[1]
    })(),
  )
}

{
  const issues = validate(demo())
  check('干净数据零问题（基线）', issues.length === 0, codes(issues).join())
}

{
  // 边界：极短样本也要能铺满，不能因为段数多于帧数就产生负数区间
  const short = generateVlaDemo({ range: [0, 4], hz: 10 })
  check(
    '5 帧样本仍能铺满且区间非负',
    short.instructions.every((s) => s.endFrame >= s.startFrame) && short.instructions[4].endFrame === 4,
    short.instructions.map((s) => `${s.startFrame}-${s.endFrame}`).join(' '),
  )
}

/* ==================================================================
 * 3. 规则：注入错误只报对应码
 * ================================================================== */
console.log('\n[3] 规则：注入错误')

const injections: Array<{ key: VlaDemoError; code: string }> = [
  { key: 'gap', code: 'VLA_INSTRUCTION_GAP' },
  { key: 'overlap', code: 'VLA_INSTRUCTION_OVERLAP' },
  { key: 'sign', code: 'VLA_ACTION_SIGN' },
  { key: 'lag', code: 'VLA_ACTION_LAG' },
  { key: 'textEmpty', code: 'VLA_TEXT_EMPTY' },
  { key: 'channelLength', code: 'VLA_CHANNEL_LENGTH' },
]
for (const { key, code } of injections) {
  const issues = validate(demo([key]))
  check(`注入 ${key} 报出 ${code}`, has(issues, code), codes(issues).join())
  check(`干净数据不报 ${code}`, !has(validate(demo()), code))
}

check('注入 gap 只报 GAP，不误报重叠', !has(validate(demo(['gap'])), 'VLA_INSTRUCTION_OVERLAP'))
check('注入 overlap 不误报空档', !has(validate(demo(['overlap'])), 'VLA_INSTRUCTION_GAP'))
check(
  '多条同时注入全部报出',
  (() => {
    const issues = validate(demo(['gap', 'sign', 'textEmpty']))
    return has(issues, 'VLA_INSTRUCTION_GAP') && has(issues, 'VLA_ACTION_SIGN') && has(issues, 'VLA_TEXT_EMPTY')
  })(),
)

console.log('\n[4] 规则：边界')

{
  // TEXT_DUP 默认关：连续同一句"保持车道"是真实场景，不该默认刷屏
  const d = demo()
  d.instructions[2].text = d.instructions[1].text
  check('相邻重复文本默认不报', !has(validate(d), 'VLA_TEXT_DUP'))
  check('显式开启后报出', has(validate(d, mkDoc(), { checkTextDup: true }), 'VLA_TEXT_DUP'))
}

{
  // 抖动：低帧率必须"说明不判"，而不是静默跳过或硬判
  const low = demo()
  low.hz = 2
  const issues = validate(low)
  const smooth = issues.filter((i) => i.code === 'VLA_ACTION_SMOOTH')
  check(
    'hz=2 时抖动检查出一条 info',
    smooth.length === 1 && smooth[0].severity === 'info',
    JSON.stringify(codes(issues)),
  )
  check('info 说明了原因（不是静默跳过）', /跳过/.test(smooth[0]?.message ?? ''), smooth[0]?.message)
  check('hz=10 干净数据不报抖动', !has(validate(demo()), 'VLA_ACTION_SMOOTH'))
}

{
  const d = demo()
  d.instructions[0].startFrame = -5
  check('区间越界报 VLA_INSTRUCTION_RANGE', has(validate(d), 'VLA_INSTRUCTION_RANGE'))
}
{
  const d = demo()
  d.alignment.push({ instructionId: 'ins-404', actionRange: [0, 10] })
  check('孤儿对齐报 VLA_ALIGNMENT_ORPHAN', has(validate(d), 'VLA_ALIGNMENT_ORPHAN'))
}
{
  const d = demo()
  d.channels[0].values[3] = Number.NaN
  check('NaN 采样报 VLA_CHANNEL_FINITE', has(validate(d), 'VLA_CHANNEL_FINITE'))
}
{
  // 符号约定是项目配置：把左转改成"应为正"，干净数据也必须报出来
  const d = demo()
  const flipped = withSignRule(d, 'turn-left', 'positive')
  check('改符号约定后同一份数据报 SIGN（证明表真的生效）', has(validate(flipped), 'VLA_ACTION_SIGN'))
}
{
  const d = demo()
  d.channels = d.channels.filter((c) => c.name !== 'brake')
  check('停车的 brake 通道缺失时不猜、不报 SIGN', !has(validate(d), 'VLA_ACTION_SIGN'), codes(validate(d)).join())
}
{
  const empty = createEmptyVla(10)
  check('空载荷不报任何问题（视为"本样本不做"）', validate(empty).length === 0)
}
{
  // 严重度：长度类必须是 blocker，否则导出闸门拦不住
  const issues = validate(demo(['channelLength']))
  check('CHANNEL_LENGTH 是 blocker 级', issues.find((i) => i.code === 'VLA_CHANNEL_LENGTH')?.severity === 'blocker')
  check('SIGN 是 error 级', validate(demo(['sign'])).find((i) => i.code === 'VLA_ACTION_SIGN')?.severity === 'error')
}
{
  // 规则必须给出可执行的 fixHint，而不是"检查失败"
  const all = [...validate(demo(['gap'])), ...validate(demo(['sign']))]
  check(
    '每条问题都带 fixHint',
    all.every((i) => !!i.fixHint),
  )
}

/* ==================================================================
 * 5. 编辑操作
 * ================================================================== */
console.log('\n[5] 编辑操作')

{
  const d = demo()
  const id = d.instructions[1].id
  const next = withInstructionRange(d, id, 200, 150, RANGE)
  const seg = next.instructions.find((s) => s.id === id)!
  check('区间交叉时自动交换', seg.startFrame === 150 && seg.endFrame === 200, `${seg.startFrame}-${seg.endFrame}`)
  check(
    '改区间后仍然按起点排序',
    next.instructions.every((s, i) => i === 0 || s.startFrame >= next.instructions[i - 1].startFrame),
  )
  check(
    '改区间不搬动已有对齐',
    next.alignment.find((a) => a.instructionId === id)?.actionRange.join() ===
      d.alignment.find((a) => a.instructionId === id)?.actionRange.join(),
  )
}
{
  const d = demo()
  const id = d.instructions[2].id
  const clamped = withInstructionRange(d, id, -50, 9999, RANGE)
  const seg = clamped.instructions.find((s) => s.id === id)!
  check('区间被夹到样本范围内', seg.startFrame === 0 && seg.endFrame === 299, `${seg.startFrame}-${seg.endFrame}`)
}
{
  const d = demo()
  const id = d.instructions[0].id
  const next = withInstructionText(d, id, '沿最左侧车道行驶')
  check('改文本写回', next.instructions.find((s) => s.id === id)?.text === '沿最左侧车道行驶')
  check(
    '改文本不改 source（这句话是谁提的没变）',
    next.instructions.find((s) => s.id === id)?.source.kind === 'derived',
  )
}
{
  const d = demo()
  const id = d.instructions[0].id
  const pending = setInstructionReview(d, id, 'pending')
  const edited = withInstructionText(pending, id, '换个说法')
  check('待确认的段改过文本 → 已确认', edited.instructions.find((s) => s.id === id)?.review === 'accepted')
}
{
  const d = demo()
  const id = d.instructions[1].id
  const next = removeInstruction(d, id)
  check('删指令同时删对齐', !next.alignment.some((a) => a.instructionId === id))
  check('删指令后没有孤儿', !has(validate(next), 'VLA_ALIGNMENT_ORPHAN'), codes(validate(next)).join())
  check('删指令后少一条', next.instructions.length === 4)
}
{
  const d = demo()
  const { vla: next, id } = addInstruction(d, { startFrame: 10, endFrame: 20, text: '测试' })
  check('新增指令 id 不与已有冲突', !d.instructions.some((s) => s.id === id), id)
  check(
    '新增指令带默认对齐',
    next.alignment.some((a) => a.instructionId === id),
  )
  check('新增指令默认待确认', next.instructions.find((s) => s.id === id)?.review === 'pending')
  // 这条新指令落在已有区间里 → 必然产生重叠，这是正确行为不是 bug
  check('新增到已有区间内会报重叠', has(validate(next), 'VLA_INSTRUCTION_OVERLAP'))
}
{
  const d = demo()
  check('nextInstructionId 跳过已占用号', nextInstructionId(d) === 'ins-6', nextInstructionId(d))
}
{
  const d = demo()
  const id = d.instructions[3].id
  const shifted = withAlignment(d, id, [d.instructions[3].startFrame + 5, d.instructions[3].endFrame + 5])
  check(
    '显式改对齐生效',
    alignmentOffset(
      shifted,
      shifted.instructions.find((s) => s.id === id)!,
    ) === 5,
  )
  const reset = resetAlignment(shifted, id)
  check(
    '对齐重置回指令区间',
    alignmentOffset(
      reset,
      reset.instructions.find((s) => s.id === id)!,
    ) === 0,
  )
}
{
  const d = demo()
  const pending = setInstructionReview(d, d.instructions[0].id, 'pending')
  const all = acceptAllInstructions(pending)
  check(
    '全部确认后没有 pending',
    all.instructions.every((s) => s.review !== 'pending'),
  )
}
{
  const d = demo()
  check('instructionAt 命中区间内', instructionAt(d, 10)?.id === d.instructions[0].id)
  check('instructionAt 区间外返回 undefined', instructionAt(d, 9999) === undefined)
  check(
    'actionRangeOf 无对齐时退回指令区间',
    (() => {
      const noAlign = { ...d, alignment: [] }
      return (
        actionRangeOf(noAlign, d.instructions[0]).join() ===
        [d.instructions[0].startFrame, d.instructions[0].endFrame].join()
      )
    })(),
  )
  check('ensureAlignment 只在缺失时补', ensureAlignment({ ...d, alignment: [] }).alignment.length === 5)
}
{
  const d = demo()
  const ch = d.channels[0]
  check('channelAt 取到正确值', channelAt(ch, ch.startFrame) === ch.values[0])
  check('channelAt 越界返回 null 而不是 0', channelAt(ch, 9999) === null)
  check('channelLastFrame 含端点', channelLastFrame(ch) === 299)
}

/* ==================================================================
 * 6. JSONL 与命令
 * ================================================================== */
console.log('\n[6] JSONL 与命令')

{
  const d = demo()
  const doc = mkDoc()
  const line = vlaToJsonLine(d, doc)
  check(
    '导出是单行合法 JSON',
    line.split('\n').length === 1 &&
      (() => {
        try {
          JSON.parse(line)
          return true
        } catch {
          return false
        }
      })(),
  )
  const back = parseVlaJsonl(line)
  check('回读得到 1 条记录', back.records.length === 1)
  check('回读无警告', back.warnings.length === 0, back.warnings.join())
  const rec = back.records[0]
  check('指令数量一致', rec.instructions.length === d.instructions.length)
  check('通道数量一致', rec.channels.length === d.channels.length)
  check(
    '区间逐条一致',
    rec.instructions.every(
      (s, i) => s.startFrame === d.instructions[i].startFrame && s.endFrame === d.instructions[i].endFrame,
    ),
  )
  check(
    'steer 逐值一致（用 number[] 存才保得住）',
    (() => {
      const a = d.channels.find((c) => c.name === 'steer')!.values
      const b = rec.channels.find((c) => c.name === 'steer')!.values
      return a.length === b.length && a.every((v, i) => near(v, b[i], 1e-9))
    })(),
  )
  check('hz 回读', rec.hz === 10)
}
{
  // 导出闸门：模型产出且未确认的指令不能出去
  const d = demo()
  const id = d.instructions[1].id
  const withModel = {
    ...d,
    instructions: d.instructions.map((s) =>
      s.id === id
        ? { ...s, source: { kind: 'model' as const, model: { id: 'm', version: '1' } }, review: 'pending' as const }
        : s,
    ),
  }
  const parsed = JSON.parse(vlaToJsonLine(withModel, mkDoc())) as {
    instructions: Array<{ id: string }>
    dropped?: number
  }
  check(
    '未确认的模型指令不导出',
    !parsed.instructions.some((s) => s.id === id),
    JSON.stringify(parsed.instructions.map((s) => s.id)),
  )
  check('导出里记录了被丢掉几条', parsed.dropped === 1, String(parsed.dropped))
  check(
    '其对齐关系也一起被丢掉',
    (() => {
      const doc = JSON.parse(vlaToJsonLine(withModel, mkDoc())) as { alignment: Array<{ instruction_id: string }> }
      return !doc.alignment.some((a) => a.instruction_id === id)
    })(),
  )
}
{
  const d = demo()
  const doc = mkDoc()
  const rec = parseVlaJsonl(vlaToJsonLine(d, doc)).records[0]
  const applied = recordToTask(rec, doc)
  check('recordToTask 后仍零问题', validateVla(applied, doc).length === 0, codes(validateVla(applied, doc)).join())
}
{
  const text = [
    '{"sample_id":"a","hz":10,"instructions":[{"text":"左转","start_frame":0,"end_frame":9}],"actions":{"steer":[0,0,0,0,0,-0.5,-0.6,-0.5,0,0]}}',
    'not json',
    '{"sample_id":"b","instructions":[{"text":"右转","start_frame":10,"end_frame":19}],"actions":{"steer":[null,0,0,0,0,0,0,0,0,0]}}',
  ].join('\n')
  const res = parseVlaJsonl(text)
  check('坏行被跳过而不中断整个文件', res.records.length === 2, String(res.records.length))
  check(
    '坏行给出行号',
    res.warnings.some((w) => /第 2 行/.test(w)),
    res.warnings.join(' | '),
  )
  check('缺 hz 用默认值并提示', res.records[1].hz === 10 && res.warnings.some((w) => /hz/.test(w)))
  check('null 变成 NaN 而不是 0（交给规则报）', Number.isNaN(res.records[1].channels[0].values[0]))
  check(
    'NaN 会被 VLA_CHANNEL_FINITE 抓到',
    (() => {
      const doc = mkDoc([0, 19])
      return has(validateVla(recordToTask(res.records[1], doc), doc), 'VLA_CHANNEL_FINITE')
    })(),
  )
}
{
  const text =
    '{"sample_id":"c","hz":20,"instructions":[{"text":"直行","start_frame":5,"end_frame":15}],"actions":[{"name":"steer","unit":"norm","values":[1,2,3]}]}'
  const rec = parseVlaJsonl(text).records[0]
  check('actions 用数组形式也能解析', rec.channels.length === 1 && rec.channels[0].name === 'steer')
  check('通道单位按声明保留', rec.channels[0].unit === 'norm')
}

console.log('\n[7] 注册表与命令')

{
  const reg = createDefaultRegistry()
  check('默认注册 6 个任务', reg.keys.length === 6, reg.keys.join())
  check('vla 已注册', reg.keys.includes('vla'))
  check('vla 是可选任务', reg.get('vla')?.optional === true)
}
{
  const doc = mkDoc()
  doc.tasks.vla = demo()
  const reg = createDefaultRegistry()
  const issues = reg.validate(doc)
  check('注册表校验干净文档无问题', issues.length === 0, codes(issues).join())
  const row = reg.progress(doc).find((r) => r.key === 'vla')!
  check('进度按"项"算', row.progress?.unit === 'items')
  check('进度已确认 5/5', row.progress?.done === 5 && row.progress?.total === 5, JSON.stringify(row.progress))
  check('体积估算 > 0', (reg.get('vla')?.estimateBytes(doc.tasks.vla) ?? 0) > 0)
  const errored = { ...doc, tasks: { ...doc.tasks, vla: setInstructionReview(doc.tasks.vla, 'ins-1', 'pending') } }
  const row2 = reg.progress(errored).find((r) => r.key === 'vla')!
  check(
    '有待确认时进度降下来并说明',
    row2.progress?.done === 4 && /待确认/.test(row2.progress?.note ?? ''),
    JSON.stringify(row2.progress),
  )
}
{
  const d = demo()
  const cmd = buildCreateVlaCommand(d, { label: '生成 VLA 演示' })
  check('创建命令是 setTaskPayload', cmd.type === 'setTaskPayload')
  check('创建命令 before 为空', (cmd as Extract<typeof cmd, { type: 'setTaskPayload' }>).before === null)
  check('创建命令不产生 blob 引用（VLA 不走 BlobStore）', commandBlobRefs(cmd).length === 0)
}
{
  const before = demo()
  const after = withInstructionText(before, 'ins-1', '改过的话')
  const cmd = buildVlaEditCommand(before, after, { label: '改文本' })
  const payload = cmd as Extract<typeof cmd, { type: 'setTaskPayload' }>
  check('编辑命令记录了 before/after', JSON.stringify(payload.before) !== JSON.stringify(payload.after))
  check(
    'before 是深拷贝：改 after 不影响撤销快照',
    (() => {
      after.instructions[0].text = '再改一次'
      return (payload.before as VlaTaskData).instructions[0].text !== '再改一次'
    })(),
  )
}
{
  const d = demo()
  const cmd = buildClearVlaCommand(d, { label: '清除' })
  check('清除命令 after 为空', (cmd as Extract<typeof cmd, { type: 'setTaskPayload' }>).after === null)
}

/* ==================================================================
 * 汇总
 * ================================================================== */
it('vla：重采样/合成数据/规则/编辑/JSONL 全部断言通过', () => {
  finish()
})
