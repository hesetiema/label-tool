/**
 * ============================================================
 * 时序质检 —— 单帧质检之上的"4D 一致性"检查
 * ============================================================
 *
 * 【为什么单帧质检不够】
 *   quality.ts 检查"一帧里标得准不准"；但 4D 标注还要检查"跨帧连起来对不对"。
 *   一个框在每帧都贴得很准，仍可能整体是错的：ID 串了、轨迹抖成锯齿、目标凭空消失。
 *   这些错误单帧看不出来，只有把时间轴拉开才暴露——这正是 MolarData 等平台
 *   "智能审核"里时序检查这一块的原理。
 *
 * 【四类检测（对应标注时序最常见的四种错误）】
 *   1. ID 跳变   ：同一 obj_id 相邻帧位移异常大 → 大概率把两个目标的 ID 串了
 *   2. 速度突变 ：速度大小在相邻帧骤变 → 中间帧标错位置或漏标
 *   3. 轨迹抖动 ：运动方向来回反转 → 手抖或逐帧独立标注没做平滑
 *   4. 轨迹断裂 ：目标中间帧突然消失 → 漏标（遮挡除外，遮挡应显式标记 visibility）
 *
 * 【诚实边界】
 *   这里用固定阈值 + 相邻帧统计，教学足够。生产系统会把阈值按目标类别/距离自适应，
 *   并用 Kalman 残差（观测 vs 预测）代替裸位移——预测残差对"匀速目标突然跳"更敏感。
 */
import type { FrameData } from './sequence'
import { extractTrajectories, type Trajectory } from './sequence'

/** 问题严重程度 */
export type Severity = 'error' | 'warn'

/** 单条时序问题 */
export interface TemporalIssue {
  /** 问题类型 */
  type: 'id_switch' | 'speed_jump' | 'jitter' | 'track_gap'
  severity: Severity
  objId: string
  label: string
  /** 出问题的帧号 */
  frame: number
  /** 人类可读的描述 */
  detail: string
  /** 触发的量化值（位移米 / 速度差 m/s / 角度弧度 / 缺失帧数） */
  value: number
}

/** 时序质检报告 */
export interface TemporalReport {
  frameCount: number
  trackCount: number
  issues: TemporalIssue[]
  /** 按类型统计 */
  counts: Record<TemporalIssue['type'], number>
  /** 综合健康分 0~100（100 表示无任何问题） */
  score: number
  /** 被显式标记为遮挡/预测的轨迹点数（这些点不参与精度检测与断裂判定） */
  occludedPoints: number
}

export interface TemporalQaOptions {
  /** 帧间隔（秒），用于把位移换算成速度，默认 0.5 */
  dt?: number
  /** ID 跳变位移阈值（米），默认 12 */
  maxStep?: number
  /** 速度突变阈值（m/s），默认 8 */
  maxSpeedJump?: number
  /** 轨迹抖动：方向反转角阈值（弧度），默认 2.0 */
  maxTurn?: number
}

function angleDiffSigned(a: number, b: number): number {
  let d = a - b
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return d
}

/**
 * 对帧序列做时序质检，返回所有可疑点。
 * 纯函数、输入确定输出确定，可直接单测。
 */
export function evaluateTemporal(
  frames: FrameData[],
  opts: TemporalQaOptions = {},
): TemporalReport {
  const { dt = 0.5, maxStep = 12, maxSpeedJump = 8, maxTurn = 2.0 } = opts
  const issues: TemporalIssue[] = []
  const tracks = extractTrajectories(frames)
  const frameCount = frames.length
  let occludedPoints = 0

  // ---- 检测 1/2/3：逐条轨迹分析 ----
  for (const tr of tracks) {
    const pts = tr.points
    // 统计遮挡点（predicted / occluded）
    occludedPoints += pts.filter((p) => p.visibility === 'predicted' || p.visibility === 'occluded').length
    // 检测 1：ID 跳变 + 检测 2：速度突变
    let prevSpeed: number | null = null
    let prevHeading: number | null = null
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i]
      // 该点必须是连续帧（跨缺失帧会让速度失真，跳过）
      const frameGap = b.frame - a.frame
      if (frameGap !== 1) { prevSpeed = null; prevHeading = null; continue }

      // 遮挡续接的预测框不是真实观测：位置由运动模型外推，
      // 拿它算位移/速度/方向会产生假告警。直接跳过这类段——这正是
      // "显式标记 visibility" 带来的收益：质检能区分真跳变和预测续接。
      if (a.visibility === 'predicted' || a.visibility === 'occluded'
        || b.visibility === 'predicted' || b.visibility === 'occluded') {
        prevSpeed = null; prevHeading = null
        continue
      }

      const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
      const speed = d / dt

      // ID 跳变：单帧位移过大
      if (d > maxStep) {
        issues.push({
          type: 'id_switch', severity: 'error', objId: tr.id, label: tr.label, frame: b.frame,
          detail: `目标 ${tr.id} 在第 ${a.frame}→${b.frame} 帧跳了 ${d.toFixed(1)}m（阈值 ${maxStep}m），疑似 ID 串标`,
          value: d,
        })
      }

      // 速度突变：相邻两段速度差过大
      if (prevSpeed !== null && Math.abs(speed - prevSpeed) > maxSpeedJump) {
        issues.push({
          type: 'speed_jump', severity: 'warn', objId: tr.id, label: tr.label, frame: b.frame,
          detail: `目标 ${tr.id} 速度从 ${prevSpeed.toFixed(1)} 突变到 ${speed.toFixed(1)} m/s（差 ${Math.abs(speed - prevSpeed).toFixed(1)}）`,
          value: Math.abs(speed - prevSpeed),
        })
      }

      // 检测 3：轨迹抖动 —— 连续两段运动方向近乎反转
      if (d > 0.3) {
        const heading = Math.atan2(b.y - a.y, b.x - a.x)
        if (prevHeading !== null) {
          const turn = Math.abs(angleDiffSigned(heading, prevHeading))
          if (turn > maxTurn) {
            issues.push({
              type: 'jitter', severity: 'warn', objId: tr.id, label: tr.label, frame: b.frame,
              detail: `目标 ${tr.id} 在第 ${b.frame} 帧运动方向反转 ${(turn * 180 / Math.PI).toFixed(0)}°，轨迹呈锯齿`,
              value: turn,
            })
          }
        }
        prevHeading = heading
      }
      prevSpeed = speed
    }

    // 检测 4：轨迹断裂 —— 首末帧之间某帧缺失
    // 例外：若缺失帧紧邻一个 predicted 续接点，说明目标是被遮挡、已显式标记，
    //       不是漏标 —— 这正是 visibility 字段的核心价值。
    const first = pts[0].frame
    const last = pts[pts.length - 1].frame
    for (let f = first + 1; f < last; f++) {
      if (pts.some((p) => p.frame === f)) continue
      const coveredByOcclusion = pts.some(
        (p) => (p.visibility === 'predicted' || p.visibility === 'occluded')
          && Math.abs(p.frame - f) <= 1,
      )
      if (coveredByOcclusion) continue
      issues.push({
        type: 'track_gap', severity: 'warn', objId: tr.id, label: tr.label, frame: f,
        detail: `目标 ${tr.id} 在第 ${f} 帧缺失（首末帧都有），可能是漏标`,
        value: 1,
      })
    }
  }

  const counts: Record<TemporalIssue['type'], number> = {
    id_switch: 0, speed_jump: 0, jitter: 0, track_gap: 0,
  }
  for (const issue of issues) counts[issue.type]++

  // 健康分：每个 error 扣 15、warn 扣 6，下限 0
  const penalty = issues.reduce((s, i) => s + (i.severity === 'error' ? 15 : 6), 0)
  const score = Math.max(0, 100 - penalty)

  return { frameCount, trackCount: tracks.length, issues, counts, score, occludedPoints }
}

/**
 * 生成"有时序问题"的演示序列：在干净序列上注入四类问题，用于展示质检能力。
 * 固定种子，结果可复现。
 *
 * 注入方式：
 *   - id_switch：把 id=2 目标在第 3 帧的位置横向挪 18m（远超阈值）
 *   - speed_jump：把 id=3 目标在第 4 帧位置前后拉开，制造速度骤变
 *   - jitter：把 id=5 目标在第 2/3 帧左右横跳
 *   - track_gap：删掉 id=6 目标在第 2 帧的框（generateDemoSequence 本来中间帧就没标）
 */
export function injectTemporalDefects(frames: FrameData[]): FrameData[] {
  // 深拷贝，避免污染原序列
  const out = frames.map((f) => ({
    index: f.index,
    cloud: f.cloud,
    boxes: f.boxes.map((b) => ({
      ...b,
      position: { ...b.position },
      scale: { ...b.scale },
    })),
  }))

  const setPos = (objId: string, frame: number, dx: number, dy: number) => {
    const b = out[frame]?.boxes.find((x) => x.id === objId)
    if (b) { b.position.x += dx; b.position.y += dy }
  }

  // 1. ID 跳变：id=2 在第 3 帧突然横移 18m
  setPos('2', 2, 18, 0)
  // 2. 速度突变：id=1 在第 3 帧往后拉 12m（第 2 帧→第 3 帧几乎不动，第 3→4 帧狂飙）
  setPos('1', 2, -12, 0)
  // 3. 轨迹抖动：id=5 第 2 帧往上、第 3 帧往下，方向来回反转
  setPos('5', 1, 0, 6)
  setPos('5', 2, 0, -6)
  // 4. 轨迹断裂：id=4 第 2 帧删除（它本来首末帧有、中间帧没有，这里保证首帧也在、第2帧缺失更明显）
  if (out[0]?.boxes.some((b) => b.id === '4')) {
    out[1].boxes = out[1].boxes.filter((b) => b.id !== '4')
    out[2].boxes = out[2].boxes.filter((b) => b.id !== '4')
  }

  return out
}

/**
 * 演示遮挡标记：把指定目标在指定帧的框标记为 occluded（遮挡）。
 * 用于对比"标记前报断裂 / 标记后不报"——这是 visibility 字段最直观的价值证明。
 * 深拷贝，不污染输入。
 */
export function markOccluded(
  frames: FrameData[],
  objId: string,
  frameIndex: number,
  visibility: 'occluded' | 'predicted' = 'occluded',
): FrameData[] {
  return frames.map((f, fi) => ({
    ...f,
    boxes: f.boxes.map((b) => (fi === frameIndex && b.id === objId ? { ...b, visibility } : b)),
  }))
}

/** 取问题类型的中文名，供 UI 展示 */
export function issueTypeName(type: TemporalIssue['type']): string {
  return {
    id_switch: 'ID 跳变',
    speed_jump: '速度突变',
    jitter: '轨迹抖动',
    track_gap: '轨迹断裂',
  }[type]
}

/** 给 Trajectory 一个再导出，方便调用方类型标注（无运行时开销） */
export type { Trajectory }
