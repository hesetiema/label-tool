/**
 * ============================================================
 * 合成 VLA 演示数据
 * ============================================================
 *
 * 【为什么要合成一份】
 *   仓库里没有真实 VLA 数据（方案 R4 已把它列为高风险）。没有数据时最容易
 *   做出的东西是"看起来能跑的界面"：曲线画得很漂亮，但没人知道它对不对。
 *   合成数据的作用不是冒充真数据，而是让**链路可验证**：
 *     指令段 → 区间编辑 → 动作曲线 → 规则判定 → JSONL 导出 → 回读。
 *   所以它必须是确定性的（同 seed 同结果），且**默认完全干净**（零问题）。
 *
 * 【为什么默认干净、错误要显式注入】
 *   如果演示数据天生带错，用户第一次打开就看到一堆红字，会以为工具在乱报，
 *   进而学会忽略所有提示 —— 那比没有校验更糟。
 *   干净是基线，"注入错误"是一个可点开的开关，用来演示规则真的会响。
 *
 * 【为什么通道要按 12 帧平滑升降】
 *   同一份数据要同时满足两条相反的验收：
 *     VLA_ACTION_LAG 要求动作尽快起（指令后 0.5s 内）；
 *     VLA_ACTION_SMOOTH 要求二阶差分小（不能突跳）。
 *   阶跃满足前者但违反后者，长余弦满足后者但"起转"太慢。
 *   12 帧 smoothstep 升降在 10Hz 下：起转 ≈0.18s（< 0.5 ✓），
 *   二阶差分峰值 6A/12² ≈ 0.033（< 0.05 ✓）。这个数是算出来的，不是试出来的。
 */
import type { ActionChannel, VlaTaskData, InstructionSegment } from '../model/vla'
import { DEFAULT_VLA_SIGN_MAP } from '../model/vla'

export type VlaDemoError = 'gap' | 'overlap' | 'sign' | 'lag' | 'textEmpty' | 'channelLength'

export interface VlaDemoOptions {
  range: [number, number]
  /** 样本帧率。演示默认 10Hz —— 与 IO 层的 nominalHz 一致，也高于抖动检查的门槛 */
  hz?: number
  seed?: number
  /** 显式注入的错误；空数组 = 干净数据 */
  errors?: VlaDemoError[]
}

interface SegSpec {
  text: string
  tags: string[]
  weight: number
  /** steer 钟形幅度；0 表示这段不转向 */
  amp: number
}

const SEGS: SegSpec[] = [
  { text: '沿左侧车道保持行驶', tags: ['keep-lane'], weight: 0.22, amp: 0 },
  { text: '前方路口左转', tags: ['turn-left'], weight: 0.22, amp: -0.5 },
  { text: '通过路口后继续直行', tags: ['go-straight'], weight: 0.16, amp: 0 },
  { text: '右侧车道有慢车，向右变道', tags: ['lane-change-right'], weight: 0.22, amp: 0.35 },
  { text: '前方红灯，减速停车', tags: ['stop'], weight: 0.18, amp: 0 },
]

/**
 * 通道锚点：**每段起点**的值，外加一个"样本末帧的值"。
 * 段内线性过渡 —— 线性段的二阶差分为 0，不会误触抖动规则，
 * 也符合"油门/车速是缓慢变化"的直觉。
 * `brake` 不在这里：刹车是阶跃式踩下，用 smoothstep 单独生成更真实。
 */
const ANCHORS: Record<string, number[]> = {
  throttle: [0.62, 0.5, 0.4, 0.52, 0.28, 0],
  speed: [12, 10.5, 9.2, 10.4, 10.2, 0],
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const smoothstep = (x: number) => {
  const t = clamp(x, 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * 钟形转向剖面：0 → A（12 帧 smoothstep）→ 保持 → 0。
 * `shift` 把整条钟形往后推 n 帧，用于注入"起转滞后"。
 */
function steerBell(n: number, amp: number, shift = 0): number[] {
  const out = new Array<number>(n).fill(0)
  if (amp === 0) return out
  const s = clamp(Math.round(shift), 0, Math.max(0, n - 2))
  const m = n - s
  const ramp = clamp(12, 1, Math.max(1, Math.floor(m / 3)))
  for (let i = 0; i < m; i++) {
    let f: number
    if (i < ramp) f = smoothstep(i / ramp)
    else if (i > m - 1 - ramp) f = smoothstep((m - 1 - i) / ramp)
    else f = 1
    out[s + i] = amp * f
  }
  return out
}

/** 把 [a,b] 按权重切成 n 段且**恰好铺满**：不留缝、不重叠、末段收到 b */
function tile(a: number, b: number, weights: number[]): Array<[number, number]> {
  const n = b - a + 1
  const sum = weights.reduce((x, y) => x + y, 0)
  const out: Array<[number, number]> = []
  let cursor = a
  let acc = 0
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i]
    // 用累计比例算"该段应该结束在哪"，最后一段直接收到 b，
    // 这样舍入误差全部由末段吸收，不会出现累积偏移
    const target = i === weights.length - 1 ? b : a + Math.round((n * acc) / sum) - 1
    const end = Math.max(cursor, Math.min(b, target))
    out.push([cursor, end])
    cursor = end + 1
  }
  return out
}

/** 简单确定性 PRNG。不用 Math.random：测试要能复现同一个样本 */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 生成一份演示载荷。
 *
 * 返回值是**完整可用的 @VlaTaskData**，直接 `setTaskPayload` 写进文档即可。
 */
export function generateVlaDemo(opts: VlaDemoOptions): VlaTaskData {
  const hz = opts.hz && opts.hz > 0 ? opts.hz : 10
  const [a, b] = opts.range
  const n = Math.max(1, b - a + 1)
  const errors = new Set(opts.errors ?? [])
  const rng = mulberry32(opts.seed ?? 20261125)

  const spans = tile(a, b, SEGS.map((s) => s.weight))

  const instructions: InstructionSegment[] = SEGS.map((spec, i) => ({
    id: `ins-${i + 1}`,
    // seed 只影响文本里的"语气词"，不影响任何规则判定；
    // 加它是为了让"换种子"能被看出是换了一份数据，而不是完全一样
    text: spec.text + (spec.tags[0] === 'keep-lane' && rng() > 0.6 ? '（保持车距）' : ''),
    lang: 'zh',
    startFrame: spans[i][0],
    endFrame: spans[i][1],
    source: { kind: 'derived' },
    review: 'accepted',
    tags: spec.tags,
  }))

  /* ---- 注入 1/2：区间空档与重叠（改指令区间，不动通道）---- */
  if (errors.has('gap')) {
    // 把第 3 段的起点往后推 4 帧，制造一段无指令覆盖的真空
    const seg = instructions[2]
    seg.startFrame = Math.min(seg.endFrame, seg.startFrame + 4)
  }
  if (errors.has('overlap')) {
    // 第 2 段越界压到第 3 段开头 2 帧：只改终点，不动第 3 段起点，
    // 这样"重叠"是真重叠，不会顺手制造一个空档
    const seg = instructions[1]
    seg.endFrame = Math.min(instructions[2].endFrame, seg.endFrame + 2)
  }
  if (errors.has('textEmpty')) {
    instructions[4].text = '…'
  }

  /* ---- 通道 ---- */
  const steer = new Array<number>(n).fill(0)
  SEGS.forEach((spec, i) => {
    if (!spec.amp) return
    const [s, e] = spans[i]
    const len = e - s + 1
    const shift = errors.has('lag') && spec.tags[0] === 'turn-left' ? Math.round(hz * 0.8) : 0
    const amp = errors.has('sign') && spec.tags[0] === 'turn-left' ? -spec.amp : spec.amp
    const profile = steerBell(len, amp, shift)
    for (let k = 0; k < len; k++) steer[s - a + k] = profile[k]
  })

  const linearChannel = (name: string): number[] => {
    const anchors = ANCHORS[name]
    const out = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      const frame = a + i
      let k = spans.findIndex(([s, e]) => frame >= s && frame <= e)
      if (k < 0) k = spans.length - 1
      const [s, e] = spans[k]
      const t = e > s ? (frame - s) / (e - s) : 0
      const from = anchors[k]
      const to = anchors[Math.min(anchors.length - 1, k + 1)]
      out[i] = from + (to - from) * t
    }
    return out
  }

  /**
   * 刹车：红灯段里 smoothstep 踩下并保持。
   * 不用线性过渡 —— 线性意味着"变道段就开始轻踩"，语义不对；
   * 而阶跃又会在曲线上出现一根竖线。12 帧 smoothstep 两头都照顾到。
   */
  const brakeValues = (): number[] => {
    const out = new Array<number>(n).fill(0)
    const [s, e] = spans[spans.length - 1]
    const len = e - s + 1
    const ramp = clamp(12, 1, Math.max(1, Math.floor(len / 2)))
    for (let i = 0; i < len; i++) out[s - a + i] = 0.72 * smoothstep(i / ramp)
    return out
  }

  const channels: ActionChannel[] = [
    { name: 'steer', unit: 'norm', values: steer, startFrame: a, sourceHz: hz },
    { name: 'throttle', unit: 'norm', values: linearChannel('throttle'), startFrame: a, sourceHz: hz },
    { name: 'brake', unit: 'norm', values: brakeValues(), startFrame: a, sourceHz: hz },
    { name: 'speed', unit: 'm/s', values: linearChannel('speed'), startFrame: a, sourceHz: hz },
  ]

  /* ---- 注入 3：通道长度不一致 ---- */
  if (errors.has('channelLength')) {
    // 少一个采样：JSONL 里常见于"最后一行被截断"
    const brake = channels.find((c) => c.name === 'brake')!
    brake.values = brake.values.slice(0, -1)
  }

  return {
    instructions,
    channels,
    alignment: instructions.map((s) => ({ instructionId: s.id, actionRange: [s.startFrame, s.endFrame] as [number, number] })),
    hz,
    signMap: { ...DEFAULT_VLA_SIGN_MAP },
    source: { kind: 'derived' },
  }
}
