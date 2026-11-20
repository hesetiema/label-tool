/**
 * ============================================================
 * 生产级数据关联 —— Hungarian 全局最优 + Kalman 运动预测
 * ============================================================
 *
 * 【这一节解决什么问题】
 * 上一版 associateNearest 用贪心最近邻：算出所有距离，从小到大配对。
 * 它在"两辆车交叉经过"时会配错 —— 因为局部最优不等于全局最优。
 * 经典反例（面试可以直接画在白板上）：
 *
 *   上一帧:  A 在 x=8     B 在 x=12
 *   当前帧:  A'在 x=12    B'在 x=8      ← 两车相向而行，0.5 秒后交叉换位
 *
 *   纯距离贪心：A 离 B' 只有 0、B 离 A' 只有 0 → 总距离 0，"完美匹配"！
 *               但两个 ID 完全串了 —— A 变成了 B'、B 变成了 A'。
 *   Kalman + Hungarian：A 预测 8+8×0.5=12（向右）、B 预测 12-8×0.5=8（向左），
 *               于是 A→A'、B→B'，总距离同样是 0，但 ID 正确保持。
 *
 *   这个案例的杀伤力在于：**贪心的"完美距离"恰恰是错的最离谱的**。
 *   光看距离会掉进陷阱，必须引入运动模型（Kalman）才知道谁该配谁。
 *
 * 【算法职责划分】
 *   - hungarian()          : 纯算法，解矩形代价矩阵的最小权完美匹配
 *   - KalmanFilter2D       : 常速度模型，状态 [x,y,vx,vy]，预测+更新
 *   - associateHungarianKalman(): 把两者组装成完整关联流程
 *   - demoCrossingCase()   : 生成上面那个交叉反例，供 UI 现场演示
 *
 * 【诚实边界】
 *   这里是 2D 常速度模型 + 欧氏距离代价。生产多用 3D/9 维状态、马氏距离
 *   （考虑协方差）、JPDA/多假设跟踪处理密集遮挡。本实现用于讲清原理。
 */

import type { Box3D } from './types'

/** 分配结果：第 row 个 track 匹配第 col 个 detection */
export interface Assignment {
  row: number
  col: number
  cost: number
}

/**
 * Hungarian 算法（Kuhn-Munkres）求解最小代价二分图匹配。
 *
 * 问题定义：有 n 个 track、m 个 detection，cost[i][j] 是配对代价。
 * 要找一一对应，使总代价最小。暴力枚举是 O(n!)，Hungarian 是 O(n³)。
 *
 * 实现思路（KM 算法的标准套路）：
 *   1) 把"最小化代价"转成"最大化收益"：gain = maxCost - cost
 *   2) 用势能 lx[i] / ly[j] 维护可行标，满足 lx[i]+ly[j] >= gain[i][j]
 *   3) 对每个 track 找增广路；找不到就调整势能（松弛），直到找到
 *   4) 补零把矩形矩阵变成方阵，未匹配的虚拟节点收益为 0
 *
 * 为什么整数化：势能相等判断 `lx+ly === gain` 对浮点很敏感。
 * 把收益乘 1e6 取整后，判断完全精确 —— 这是工程实现的关键细节。
 */
export function hungarian(cost: number[][]): Assignment[] {
  const n = cost.length
  if (n === 0) return []
  const m = cost[0].length
  if (m === 0) return []
  const N = Math.max(n, m)
  const SCALE = 1e6

  // 找有效代价最大值（超大门控值不参与，避免污染势能）
  const BIG = 1e9
  let maxCost = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const c = cost[i][j]
      if (c < BIG && c > maxCost) maxCost = c
    }
  }

  // 收益矩阵：真实配对 gain = (maxCost - c + 1) × SCALE；虚拟/超门控配对 gain = 0
  // 加 1 是关键：保证任何有效配对的收益都 > 0（即使 c 恰好等于 maxCost）。
  // 否则当所有代价都为 0 时，收益全 0，Hungarian 分不清"真实配对"和"虚拟节点"，
  // 会返回空结果 —— 这是 KM 算法工程实现必踩的边界坑。
  const gain: number[][] = []
  for (let i = 0; i < N; i++) {
    const row: number[] = []
    for (let j = 0; j < N; j++) {
      if (i < n && j < m) {
        const c = cost[i][j]
        row.push(c >= BIG ? 0 : Math.round((maxCost - c + 1) * SCALE))
      } else {
        row.push(0)
      }
    }
    gain.push(row)
  }

  // 势能初始化：lx[i] = 该行最大收益
  const lx = new Array<number>(N).fill(0)
  const ly = new Array<number>(N).fill(0)
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) lx[i] = Math.max(lx[i], gain[i][j])
  }
  const matchX = new Array<number>(N).fill(-1)
  const matchY = new Array<number>(N).fill(-1)

  /** 为 track x 寻找增广路（DFS 版，递归深度 = N，规模小够用） */
  function dfs(x: number, visitedX: boolean[], visitedY: boolean[]): boolean {
    visitedX[x] = true
    for (let y = 0; y < N; y++) {
      if (visitedY[y]) continue
      // 相等边（tight edge）才能走
      if (lx[x] + ly[y] !== gain[x][y]) continue
      visitedY[y] = true
      if (matchY[y] === -1 || dfs(matchY[y], visitedX, visitedY)) {
        matchX[x] = y
        matchY[y] = x
        return true
      }
    }
    return false
  }

  for (let x = 0; x < N; x++) {
    // 每次尝试都可能要松弛多轮势能
    for (;;) {
      const visitedX = new Array<boolean>(N).fill(false)
      const visitedY = new Array<boolean>(N).fill(false)
      if (dfs(x, visitedX, visitedY)) break

      // 计算最小松弛量 delta：只在 visitedX × (未 visitedY) 上找
      let delta = Infinity
      for (let i = 0; i < N; i++) {
        if (!visitedX[i]) continue
        for (let j = 0; j < N; j++) {
          if (visitedY[j]) continue
          delta = Math.min(delta, lx[i] + ly[j] - gain[i][j])
        }
      }
      if (!Number.isFinite(delta)) break // 理论上不会发生，防御性退出
      for (let i = 0; i < N; i++) if (visitedX[i]) lx[i] -= delta
      for (let j = 0; j < N; j++) if (visitedY[j]) ly[j] += delta
    }
  }

  const out: Assignment[] = []
  for (let i = 0; i < n; i++) {
    const j = matchX[i]
    // 过滤掉：虚拟节点、超门控配对（gain=0 表示这条边不该用）
    if (j >= 0 && j < m && cost[i][j] < BIG) {
      out.push({ row: i, col: j, cost: cost[i][j] })
    }
  }
  return out
}

/**
 * 贪心最近邻（保留旧算法，用于 UI 对比演示）。
 * 与 sequence.ts 的 associateNearest 同思路，但返回分配结果而不修改框。
 */
export function greedyAssign(cost: number[][], maxCost = Infinity): Assignment[] {
  const n = cost.length
  if (n === 0) return []
  const m = cost[0].length
  const pairs: Assignment[] = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) pairs.push({ row: i, col: j, cost: cost[i][j] })
  }
  pairs.sort((a, b) => a.cost - b.cost)
  const usedRow = new Set<number>()
  const usedCol = new Set<number>()
  const out: Assignment[] = []
  for (const p of pairs) {
    if (p.cost > maxCost) continue
    if (usedRow.has(p.row) || usedCol.has(p.col)) continue
    usedRow.add(p.row)
    usedCol.add(p.col)
    out.push(p)
  }
  return out
}

/**
 * 2D 常速度 Kalman 滤波器。
 *
 * 状态向量 x = [px, py, vx, vy]，假设目标匀速运动（过程噪声吸收加速度）。
 * 两个核心方程：
 *   预测：x̂ = F·x,  P = F·P·Fᵀ + Q
 *   更新：K = P·Hᵀ(H·P·Hᵀ + R)⁻¹,  x = x̂ + K(z - H·x̂)
 *
 * F 是状态转移矩阵（dt 决定速度如何影响位置），H 把状态映射到观测量
 * （我们只观测位置，不直接观测速度）。P 是协方差，表示"对状态的不确定性"：
 * 预测时 P 变大（越来越不确定），观测更新后 P 变小（被观测拉回来了）。
 */
export class KalmanFilter2D {
  px: number
  py: number
  vx: number
  vy: number
  /** 4×4 状态协方差矩阵，展平为长度 16 的数组 */
  P: Float64Array

  constructor(px: number, py: number, vx = 0, vy = 0, initialUncertainty = 100) {
    this.px = px
    this.py = py
    this.vx = vx
    this.vy = vy
    this.P = new Float64Array(16)
    for (let i = 0; i < 4; i++) this.P[i * 4 + i] = initialUncertainty
  }

  /** 4×4 矩阵乘法：A × B（用于 F·P·Fᵀ） */
  private static mul4(A: Float64Array, B: Float64Array): Float64Array {
    const C = new Float64Array(16)
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let s = 0
        for (let k = 0; k < 4; k++) s += A[i * 4 + k] * B[k * 4 + j]
        C[i * 4 + j] = s
      }
    }
    return C
  }

  /**
   * 预测下一步位置。
   * @param dt 帧间隔（秒）
   * @param processNoise 过程噪声 Q（越大越相信观测、越不信匀速假设）
   */
  predict(dt: number, processNoise = 0.5): { x: number; y: number } {
    this.px += this.vx * dt
    this.py += this.vy * dt

    // F = [[1,0,dt,0],[0,1,0,dt],[0,0,1,0],[0,0,0,1]]
    const F = new Float64Array(16)
    for (let i = 0; i < 4; i++) F[i * 4 + i] = 1
    F[0 * 4 + 2] = dt
    F[1 * 4 + 3] = dt

    // Fᵀ
    const Ft = new Float64Array(16)
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) Ft[j * 4 + i] = F[i * 4 + j]
    }
    const FP = KalmanFilter2D.mul4(F, this.P)
    const FPFt = KalmanFilter2D.mul4(FP, Ft)
    // P = F·P·Fᵀ + Q（Q 简化为对角阵）
    for (let i = 0; i < 4; i++) FPFt[i * 4 + i] += processNoise
    this.P = FPFt
    return { x: this.px, y: this.py }
  }

  /**
   * 用观测值 (zx, zy) 修正状态。
   * @param measurementNoise 观测噪声 R（激光雷达定位精度，米²）
   */
  update(zx: number, zy: number, measurementNoise = 1): void {
    const P = this.P
    // 新息（innovation）= 观测 - 预测
    const y0 = zx - this.px
    const y1 = zy - this.py

    // S = H·P·Hᵀ + R，H 只取状态前两维（位置），所以 S 就是 P 左上角 2×2 + R
    const s00 = P[0] + measurementNoise
    const s01 = P[1]
    const s10 = P[4]
    const s11 = P[5] + measurementNoise
    const det = s00 * s11 - s01 * s10
    if (Math.abs(det) < 1e-9) return
    // S⁻¹（2×2 矩阵求逆）
    const i00 = s11 / det
    const i01 = -s01 / det
    const i10 = -s10 / det
    const i11 = s00 / det

    // K = P·Hᵀ·S⁻¹。Hᵀ = [[1,0],[0,1],[0,0],[0,0]]，
    // 所以 P·Hᵀ 就是 P 的前两列，K 的第 i 行 = [P[i,0], P[i,1]] · S⁻¹
    const K = new Float64Array(8) // 4×2
    for (let i = 0; i < 4; i++) {
      const a = P[i * 4 + 0], b = P[i * 4 + 1]
      K[i * 2 + 0] = a * i00 + b * i10
      K[i * 2 + 1] = a * i01 + b * i11
    }

    // 状态更新：x = x̂ + K·新息
    this.px += K[0] * y0 + K[1] * y1
    this.py += K[2] * y0 + K[3] * y1
    this.vx += K[4] * y0 + K[5] * y1
    this.vy += K[6] * y0 + K[7] * y1

    // 协方差更新：P = (I - K·H)·P
    // K·H 只有前两列非零，展开后直接按公式改，避免再造 4×4 矩阵
    const newP = new Float64Array(16)
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        newP[i * 4 + j] = P[i * 4 + j]
          - K[i * 2] * P[0 * 4 + j]
          - K[i * 2 + 1] * P[1 * 4 + j]
      }
    }
    this.P = newP
  }

  /** 当前估计位置（用于生成代价矩阵） */
  position(): { x: number; y: number } {
    return { x: this.px, y: this.py }
  }
}

/** 跟踪轨迹的生命周期状态（生产跟踪器的标准三态） */
export type TrackState = 'alive' | 'occluded' | 'dead'

/**
 * 一条被跟踪的轨迹：持有 obj_id、最近一次框、以及 Kalman 状态
 */
export interface Track {
  id: string
  box: Box3D
  kf: KalmanFilter2D
  /** 连续未匹配的帧数，超过阈值判定为 occluded/dead */
  missedFrames: number
  /** 当前生命周期状态 */
  state: TrackState
  /** 累计成功匹配次数（区分刚初始化的轨迹与稳定轨迹） */
  hits: number
}

/** 关联结果（供 UI 展示对比） */
export interface AssociationResult {
  assignments: Assignment[]
  /** 因超出门控而被拒绝的配对数 */
  gated: number
  /** 未匹配上的检测框索引（可能是新目标） */
  unmatchedDetections: number[]
  /** 未匹配上的轨迹 id（可能暂时被遮挡） */
  unmatchedTracks: string[]
}

/**
 * 生产级关联完整链路：Kalman 预测 → 门控 → Hungarian 全局分配 → Kalman 更新。
 *
 * 与贪心最近邻的本质区别：
 *   贪心只看"当前观测与上一帧观测"的距离，目标快速移动或交叉时会串 ID；
 *   这里用 Kalman **预测当前位置**再比较，且用门控拒绝不合理配对，
 *   最后 Hungarian 保证全局最优（不会为了一个近配牺牲两个好配）。
 *
 * @param tracks 已有轨迹（函数内部会 predict，但不修改原始 box）
 * @param detections 当前帧检测框
 * @param dt 帧间隔秒
 * @param gate 门控距离（米），预测位置与观测距离超过此值视为"不是同一目标"
 */
export function associateHungarianKalman(
  tracks: Track[],
  detections: Box3D[],
  dt: number,
  gate = 4,
): AssociationResult {
  // 1) 每条轨迹用 Kalman 预测"现在应该在哪"
  const predicted = tracks.map((t) => t.kf.predict(dt))

  // 2) 构造代价矩阵：预测位置到观测的距离；超门控的填 BIG
  const BIG = 1e9
  const cost: number[][] = []
  for (let i = 0; i < tracks.length; i++) {
    const row: number[] = []
    for (let j = 0; j < detections.length; j++) {
      const d = detections[j].position
      const dist = Math.hypot(predicted[i].x - d.x, predicted[i].y - d.y)
      row.push(dist > gate ? BIG : dist)
    }
    cost.push(row)
  }

  // 3) Hungarian 全局最优分配
  const assignments = hungarian(cost)
  const usedTracks = new Set(assignments.map((a) => a.row))
  const usedDets = new Set(assignments.map((a) => a.col))

  // 4) 对匹配上的轨迹用观测修正 Kalman 状态，并同步 box 位置
  for (const a of assignments) {
    const t = tracks[a.row]
    const d = detections[a.col]
    t.    kf.update(d.position.x, d.position.y)
    // 用观测位置作为新的 box 位置（保持 id/label/scale/朝向不变）
    t.box = {
      ...t.box,
      position: { ...d.position },
      visibility: 'visible',
    }
    t.missedFrames = 0
    t.hits++
    t.state = 'alive'
  }

  // 4b) 失配轨迹：递增 missedFrames（这才是它真正该有的语义）
  //     当前帧没观测到 ≠ 目标消失，可能只是遮挡；状态由 stepTrackState 判定
  const matchedRows = new Set(assignments.map((a) => a.row))
  for (let i = 0; i < tracks.length; i++) {
    if (matchedRows.has(i)) continue
    tracks[i].missedFrames++
  }

  // 统计被门控拒绝的候选对（用于 UI 说明"为什么没配"）
  let gated = 0
  for (let i = 0; i < tracks.length; i++) {
    for (let j = 0; j < detections.length; j++) {
      if (cost[i][j] >= BIG) gated++
    }
  }

  return {
    assignments,
    gated,
    unmatchedDetections: detections.map((_, j) => j).filter((j) => !usedDets.has(j)),
    unmatchedTracks: tracks.map((_, i) => i).filter((i) => !usedTracks.has(i)).map((i) => tracks[i].id),
  }
}

/** 从一批框初始化轨迹（速度未知，设为 0，靠前两帧观测估计） */
export function initTracks(boxes: Box3D[]): Track[] {
  return boxes.map((b) => ({
    id: b.id,
    box: { ...b, position: { ...b.position }, scale: { ...b.scale } },
    kf: new KalmanFilter2D(b.position.x, b.position.y),
    missedFrames: 0,
    state: 'alive' as TrackState,
    hits: 0,
  }))
}

/**
 * 轨迹状态机：根据 missedFrames 判定 alive → occluded → dead。
 *
 * 这是"遮挡不是简单丢失"的核心语义：
 *   - missedFrames = 0        → alive，每帧都有观测
 *   - 1..maxOccludedFrames    → occluded，短暂遮挡，保留 ID 用预测续接
 *   - > maxDeadFrames         → dead，目标确实离开/消失，轨迹终止不再预测
 *
 * 为什么要分两级：真实场景里目标会被卡车挡住几帧又出现（occluded），
 * 也可能驶出视野永不回来（dead）。只用单一阈值会要么过早丢弃、要么无限续假框。
 */
export function stepTrackState(
  tracks: Track[],
  maxDeadFrames = 8,
): { becameOccluded: string[]; becameDead: string[] } {
  const becameOccluded: string[] = []
  const becameDead: string[] = []
  for (const t of tracks) {
    const prev = t.state
    if (t.missedFrames === 0) {
      t.state = 'alive'
    } else if (t.missedFrames > maxDeadFrames) {
      t.state = 'dead'
    } else if (t.missedFrames > 0) {
      t.state = 'occluded'
    }
    if (t.state !== prev) {
      if (t.state === 'occluded') becameOccluded.push(t.id)
      if (t.state === 'dead') becameDead.push(t.id)
    }
  }
  return { becameOccluded, becameDead }
}

/**
 * Coasting（预测续接）：对 occluded 轨迹，用 Kalman 预测位置生成"幽灵框"。
 *
 * 关键点：预测位置来自 kf.predict(dt) 已经推进的状态（关联时每帧都 predict 一次），
 * 这里直接取 kf.position() 作为续接框中心，并把 visibility 标成 'predicted'，
 * 这样下游渲染能画成虚线、质检知道它不算漏标。
 *
 * 注意：只续接 occluded（短暂遮挡），dead 轨迹不再产出框——否则会留下无穷多的假目标。
 */
export function coastOccludedTracks(tracks: Track[]): Box3D[] {
  const ghosts: Box3D[] = []
  for (const t of tracks) {
    if (t.state !== 'occluded') continue
    const p = t.kf.position()
    ghosts.push({
      ...t.box,
      id: t.id,
      position: { x: p.x, y: p.y, z: t.box.position.z },
      visibility: 'predicted',
    })
  }
  return ghosts
}

/**
 * 生成"目标被遮挡后消失又重现"的演示数据，用于 UI 展示状态机。
 * 返回逐帧的检测框列表：目标 A 在第 2~3 帧被挡住（无观测），第 4 帧重现。
 */
export function demoOcclusionCase(): { frames: Box3D[][]; expectedStates: TrackState[][] } {
  const mk = (id: string, x: number): Box3D => ({
    id, label: 'Car',
    position: { x, y: 0, z: 0.8 }, scale: { x: 4.5, y: 1.8, z: 1.6 }, yaw: 0,
  })
  // A 匀速向右 5m/s，dt=0.5 → 每帧 +2.5m；第 2、3 帧消失
  const ax = [0, 2.5, null, null, 7.5]
  const frames: Box3D[][] = ax.map((x) => (x === null ? [] : [mk('A', x)]))
  return {
    frames,
    expectedStates: [
      ['alive'], ['alive'], ['occluded'], ['occluded'], ['alive'],
    ],
  }
}

/**
 * 生成"贪心失效"演示案例：两辆车交叉换位。
 *
 * 返回上一帧两车、当前帧两车，以及两种算法各自的分配。
 * 注意这个案例里纯距离贪心会把 ID 串掉（A'离B近、B'离A近），
 * 而 Kalman 预测 + 门控会拒绝这种不合理配对 —— 这正是生产用它的原因。
 */
export function demoCrossingCase(): {
  prev: Box3D[]
  curr: Box3D[]
  greedy: Assignment[]
  kalman: AssociationResult
  cost: number[][]
} {
  const mk = (id: string, x: number, y: number): Box3D => ({
    id, label: 'Car',
    position: { x, y, z: 0.8 }, scale: { x: 4.5, y: 1.8, z: 1.6 }, yaw: 0,
  })
  // 上一帧：A 在左(x=8)、B 在右(x=12)
  const prev = [mk('A(原左车)', 8, 0), mk('B(原右车)', 12, 0)]
  // 当前帧：两车相向而行 4m（速度 8m/s × 0.5s，合理车速）后完全换位
  const curr = [mk('?', 12, 0), mk('?', 8, 0)]

  // 纯观测距离：贪心会选 A'↔B(距离0) 和 B'↔A(距离0) —— 总距离 0 但 ID 全串
  const obsCost: number[][] = []
  for (const p of prev) {
    obsCost.push(curr.map((c) => Math.hypot(p.position.x - c.position.x, p.position.y - c.position.y)))
  }
  const greedy = greedyAssign(obsCost)

  // Kalman 版：注入两车真实速度，预测位置正确跟随运动方向
  const tracks = initTracks(prev)
  tracks[0].kf.vx = 8   // A 向右 8m/s
  tracks[1].kf.vx = -8  // B 向左 8m/s
  const kalman = associateHungarianKalman(tracks, curr, 0.5, 3)

  return { prev, curr, greedy, kalman, cost: obsCost }
}
