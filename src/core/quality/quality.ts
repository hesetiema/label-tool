/**
 * ============================================================
 * 质检与一致性度量 —— "标得准不准"的量化答案
 * ============================================================
 *
 * 为什么这个文件很重要（面试视角）：
 * 大部分候选人只会说"我做了一个标注工具"，但面试官真正想听的是
 * "你怎么保证标注质量"。这个模块把质量问题变成可计算的指标：
 *   - IoU         : 两个框贴不贴得上（边界精度）
 *   - 匹配        : 两版标注里哪些是同一个目标
 *   - 漏标/误标   : 有多少目标漏了、有多少是多标的
 *   - Cohen's kappa: 两个标注员的一致性（排除"碰巧一致"）
 *
 * 这些正是 DeepSeek 第 7 项"质检、指标与数据治理"落地后的样子。
 *
 * 算法选择说明（诚实边界）：
 *   - 3D IoU 用「BEV 旋转矩形精确交面积 × 高度重叠比」近似。
 *     真正的 3D OBB 相交要用 SAT 或凸多面体裁剪，工程上更复杂；
 *     自动驾驶质检绝大多数看 BEV IoU，这个近似足够且更快。
 *   - 目标匹配用贪心最大 IoU 优先。生产系统用 Hungarian 算法求全局最优
 *     （贪心在密集目标时会陷入局部最优），这里为教学保持简单。
 */
import type { Box3D } from '../types'

/** 二维点（BEV 平面上的 x/y） */
type Pt = { x: number; y: number }

/** 一个匹配上的目标对：GT 与第二版标注中的对应框 */
export interface MatchPair {
  /** ground truth（可信版本，例如质检员复核过的） */
  gt: Box3D
  /** 待评估版本（例如新人标的、或模型预标注的） */
  pred: Box3D
  /** 3D IoU（近似） */
  iou: number
  /** BEV 平面 IoU（旋转矩形精确交面积） */
  bevIou: number
}

/** 完整质检报告 */
export interface QualityReport {
  gtCount: number
  predCount: number
  matched: MatchPair[]
  /** 漏标：GT 有、待评估版本没有对应框 */
  missed: Box3D[]
  /** 误标：待评估版本有、GT 中没有对应框 */
  spurious: Box3D[]
  metrics: {
    /** 平均 IoU，边界精度指标 */
    meanIoU: number
    /** 平均 BEV IoU */
    meanBevIoU: number
    /** 召回率 = 1 - 漏标率 */
    recall: number
    /** 精确率 = 1 - 误标率 */
    precision: number
    /** 漏标率 */
    missRate: number
    /** 误标率 */
    falsePositiveRate: number
    /** F1：精确率与召回率的调和平均 */
    f1: number
    /** 类别一致性（只统计匹配上的框，排除"碰巧一致"） */
    kappa: number
    /** 中心点平均偏移（米） */
    centerError: number
    /** 朝向平均误差（弧度） */
    yawError: number
  }
}

/** 叉积：用于判断点在多边形边的哪一侧 */
function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

/**
 * 把 3D 框展开成 BEV 上的 4 个角点，保证逆时针(CCW)顺序。
 * 逆时针是后面多边形裁剪算法的前提——方向反了交集会算成 0。
 *
 * 局部坐标顺序 [(+x,-y), (+x,+y), (-x,+y), (-x,-y)] 是 CCW，
 * 旋转不改变手性，所以绕 z 转 yaw 后依然 CCW。
 */
export function boxBevCorners(box: Box3D): Pt[] {
  const hx = box.scale.x / 2
  const hy = box.scale.y / 2
  const local: [number, number][] = [
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
    [-hx, -hy],
  ]
  const c = Math.cos(box.yaw)
  const s = Math.sin(box.yaw)
  return local.map(([lx, ly]) => ({
    x: box.position.x + lx * c - ly * s,
    y: box.position.y + lx * s + ly * c,
  }))
}

/** 多边形面积（鞋带公式），CCW 时为正 */
function polygonArea(poly: Pt[]): number {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    area += a.x * b.y - b.x * a.y
  }
  return Math.abs(area) / 2
}

/** 求线段 S→E 所在直线与 A→B 所在直线的交点（S 在边外、E 在边内时调用） */
function lineIntersection(s: Pt, e: Pt, a: Pt, b: Pt): Pt {
  const dx = e.x - s.x
  const dy = e.y - s.y
  const ex = b.x - a.x
  const ey = b.y - a.y
  const denom = dx * ey - dy * ex
  if (Math.abs(denom) < 1e-12) return { ...e } // 平行，直接返回端点
  const t = ((a.x - s.x) * ey - (a.y - s.y) * ex) / denom
  return { x: s.x + t * dx, y: s.y + t * dy }
}

/**
 * Sutherland–Hodgman 多边形裁剪：求 subject 与 clip 两个凸多边形的交集。
 *
 * 原理：逐条拿 clip 的边当"刀"，把 subject 切在边的内侧。
 * 每切一刀，输出的多边形就少一部分外侧区域；四刀切完剩下的就是交集。
 * 这是计算几何的经典算法，也是旋转矩形 IoU 的标准做法。
 */
function clipConvex(subject: Pt[], clip: Pt[]): Pt[] {
  let output = subject
  for (let i = 0; i < clip.length; i++) {
    if (output.length === 0) break
    const a = clip[i]
    const b = clip[(i + 1) % clip.length]
    const input = output
    output = []
    let s = input[input.length - 1]
    for (const e of input) {
      const sInside = cross(a, b, s) >= -1e-9
      const eInside = cross(a, b, e) >= -1e-9
      if (eInside) {
        if (!sInside) output.push(lineIntersection(s, e, a, b))
        output.push(e)
      } else if (sInside) {
        output.push(lineIntersection(s, e, a, b))
      }
      s = e
    }
  }
  return output
}

/**
 * BEV 平面 IoU：两个旋转矩形交面积 / 并面积。
 * 这是自动驾驶领域最常用的框匹配度量（KITTI 评测也是 BEV IoU）。
 */
export function bevIoU(a: Box3D, b: Box3D): number {
  const inter = clipConvex(boxBevCorners(a), boxBevCorners(b))
  if (inter.length < 3) return 0
  const interArea = polygonArea(inter)
  const areaA = polygonArea(boxBevCorners(a))
  const areaB = polygonArea(boxBevCorners(b))
  const union = areaA + areaB - interArea
  return union > 1e-9 ? interArea / union : 0
}

/**
 * 近似 3D IoU = BEV IoU × 高度方向重叠比。
 * 面试时主动说明这是近似：精确 3D OBB 相交需 SAT/凸多面体裁剪，
 * 但质检场景看 BEV 已经足够，且计算量小一个量级。
 */
export function boxIoU3D(a: Box3D, b: Box3D): number {
  const planar = bevIoU(a, b)
  if (planar <= 0) return 0
  const aLo = a.position.z - a.scale.z / 2
  const aHi = a.position.z + a.scale.z / 2
  const bLo = b.position.z - b.scale.z / 2
  const bHi = b.position.z + b.scale.z / 2
  const overlap = Math.max(0, Math.min(aHi, bHi) - Math.max(aLo, bLo))
  const union = Math.max(aHi, bHi) - Math.min(aLo, bLo)
  return union > 1e-9 ? planar * (overlap / union) : 0
}

/**
 * 目标匹配：在两组框之间建立一一对应关系。
 *
 * 策略：算出所有候选对的 IoU，从大到小贪心取，每帧目标只用一次。
 * 生产级做法：Hungarian 算法（全局最优）+ 运动预测门控（跨帧跟踪）。
 * 贪心在两辆车紧挨着、IoU 接近时会配错——这正是面试可以展开的点。
 *
 * @param threshold IoU 低于此值视为"不是同一个目标"，默认 0.5（KITTI 常用）
 */
export function matchBoxes(
  gt: Box3D[],
  pred: Box3D[],
  threshold = 0.5,
): { matched: MatchPair[]; missed: Box3D[]; spurious: Box3D[] } {
  const candidates: { gi: number; pi: number; iou: number; planar: number }[] = []
  for (let gi = 0; gi < gt.length; gi++) {
    for (let pi = 0; pi < pred.length; pi++) {
      const planar = bevIoU(gt[gi], pred[pi])
      const iou = boxIoU3D(gt[gi], pred[pi])
      if (iou >= threshold) candidates.push({ gi, pi, iou, planar })
    }
  }
  candidates.sort((a, b) => b.iou - a.iou)

  const gtUsed = new Set<number>()
  const predUsed = new Set<number>()
  const matched: MatchPair[] = []
  for (const c of candidates) {
    if (gtUsed.has(c.gi) || predUsed.has(c.pi)) continue
    gtUsed.add(c.gi)
    predUsed.add(c.pi)
    matched.push({ gt: gt[c.gi], pred: pred[c.pi], iou: c.iou, bevIou: c.planar })
  }
  return {
    matched,
    missed: gt.filter((_, i) => !gtUsed.has(i)),
    spurious: pred.filter((_, i) => !predUsed.has(i)),
  }
}

/**
 * Cohen's kappa：排除"碰巧蒙对"的一致性系数。
 *
 * 公式：kappa = (po - pe) / (1 - pe)
 *   po = 实际一致比例（混淆矩阵对角线 / 总数）
 *   pe = 随机情况下的期望一致比例 = Σ(行占比 × 同类别列占比)
 *
 * 解读：kappa=1 完全一致，0 与随机猜测无异，负数表示系统性对着干。
 * 标注行业通常要求 kappa > 0.8 才认为两版标注可互相替代。
 *
 * 注意：这里只统计"匹配上的框的类别"，漏标/误标单列指标汇报。
 * 如果把"未匹配"也当成 None 类塞进混淆矩阵，也能算，但会混淆两个维度。
 */
export function cohenKappa(matrix: number[][]): number {
  let total = 0
  for (const row of matrix) for (const v of row) total += v
  if (total === 0) return 0
  let agree = 0
  for (let i = 0; i < matrix.length; i++) agree += matrix[i][i] ?? 0
  const po = agree / total

  let expected = 0
  for (let i = 0; i < matrix.length; i++) {
    let rowSum = 0,
      colSum = 0
    for (let j = 0; j < matrix.length; j++) {
      rowSum += matrix[i][j] ?? 0
      colSum += matrix[j][i] ?? 0
    }
    expected += (rowSum / total) * (colSum / total)
  }
  if (Math.abs(1 - expected) < 1e-9) return 0
  return (po - expected) / (1 - expected)
}

/** 由匹配对构建类别混淆矩阵（行=GT类别，列=待评估类别） */
export function categoryConfusion(matched: MatchPair[], labels: string[]): number[][] {
  const index = new Map(labels.map((l, i) => [l, i]))
  const matrix = labels.map(() => labels.map(() => 0))
  for (const m of matched) {
    const i = index.get(m.gt.label)
    const j = index.get(m.pred.label)
    if (i !== undefined && j !== undefined) matrix[i][j]++
  }
  return matrix
}

/** 角度最短弧差值（与 sequence.ts 的 lerpAngle 同一套逻辑） */
function angleDiff(a: number, b: number): number {
  let d = a - b
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return Math.abs(d)
}

/** 生成完整质检报告 —— 上面所有算法在这里组装 */
export function evaluateQuality(gt: Box3D[], pred: Box3D[], threshold = 0.5): QualityReport {
  const { matched, missed, spurious } = matchBoxes(gt, pred, threshold)
  const n = matched.length
  const avg = (fn: (m: MatchPair) => number) => (n === 0 ? 0 : matched.reduce((s, m) => s + fn(m), 0) / n)

  const recall = gt.length === 0 ? 1 : n / gt.length
  const precision = pred.length === 0 ? 1 : n / pred.length
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision)

  // 类别集合取两版的并集，保证混淆矩阵维度完整
  const labels = Array.from(new Set([...gt, ...pred].map((b) => b.label))).sort()
  const kappa = cohenKappa(categoryConfusion(matched, labels))

  return {
    gtCount: gt.length,
    predCount: pred.length,
    matched,
    missed,
    spurious,
    metrics: {
      meanIoU: avg((m) => m.iou),
      meanBevIoU: avg((m) => m.bevIou),
      recall,
      precision,
      missRate: 1 - recall,
      falsePositiveRate: 1 - precision,
      f1,
      kappa,
      centerError: avg((m) =>
        Math.hypot(
          m.gt.position.x - m.pred.position.x,
          m.gt.position.y - m.pred.position.y,
          m.gt.position.z - m.pred.position.z,
        ),
      ),
      yawError: avg((m) => angleDiff(m.gt.yaw, m.pred.yaw)),
    },
  }
}

/** 可复现的伪随机数（固定种子，演示结果每次一致） */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

export interface PerturbOptions {
  /** 漏标比例 */
  missRate?: number
  /** 误标（凭空多出框）比例，相对原框数 */
  spuriousRate?: number
  /** 位置扰动幅度（米） */
  positionJitter?: number
  /** 朝向扰动幅度（弧度） */
  yawJitter?: number
  /** 尺寸扰动比例 */
  scaleJitter?: number
  /** 类别标错比例 */
  labelErrorRate?: number
}

/**
 * 生成一份"人工扰动版"标注，用来演示质检。
 *
 * 模拟真实场景中两版标注的差异来源：新人漏标、手抖导致的框偏移、
 * 类别看错、以及多标。默认参数下 kappa 和漏标率都会有明显数值，
 * 方便你在界面上直观看到指标变化。
 */
export function perturbLabels(boxes: Box3D[], seed = 42, opts: PerturbOptions = {}): Box3D[] {
  const rng = makeRng(seed)
  const {
    missRate = 0.12,
    spuriousRate = 0.15,
    positionJitter = 0.18,
    yawJitter = 0.06,
    scaleJitter = 0.05,
    labelErrorRate = 0.25,
  } = opts
  const labels = ['Car', 'Truck', 'Pedestrian', 'Rider', 'Cyclist']
  const out: Box3D[] = []

  for (const b of boxes) {
    if (rng() < missRate) continue // 模拟漏标
    const wrongLabel = rng() < labelErrorRate
    out.push({
      ...b,
      id: `review-${b.id}`,
      label: wrongLabel ? labels[Math.floor(rng() * labels.length)] : b.label,
      position: {
        x: b.position.x + (rng() - 0.5) * 2 * positionJitter,
        y: b.position.y + (rng() - 0.5) * 2 * positionJitter,
        z: b.position.z + (rng() - 0.5) * positionJitter,
      },
      scale: {
        x: b.scale.x * (1 + (rng() - 0.5) * 2 * scaleJitter),
        y: b.scale.y * (1 + (rng() - 0.5) * 2 * scaleJitter),
        z: b.scale.z * (1 + (rng() - 0.5) * 2 * scaleJitter),
      },
      yaw: b.yaw + (rng() - 0.5) * 2 * yawJitter,
    })
  }

  // 模拟误标：在已有框附近凭空多画几个
  const spuriousCount = Math.max(0, Math.round(boxes.length * spuriousRate))
  for (let k = 0; k < spuriousCount && boxes.length > 0; k++) {
    const base = boxes[Math.floor(rng() * boxes.length)]
    out.push({
      id: `spurious-${k}`,
      label: base.label,
      position: {
        x: base.position.x + (rng() - 0.5) * 12,
        y: base.position.y + (rng() - 0.5) * 12,
        z: base.position.z,
      },
      scale: { ...base.scale },
      yaw: base.yaw + (rng() - 0.5) * 0.8,
    })
  }
  return out
}
