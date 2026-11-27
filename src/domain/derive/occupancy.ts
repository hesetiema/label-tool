/**
 * ============================================================
 * 占据栅格：从轨迹派生，而不是逐格画
 * ============================================================
 *
 * 【为什么"派生"而不是"新画一个任务"】
 *   人工逐格标注 200×200×16 = 64 万个体素是不可能的。可行的分工是：
 *   框（框质量的瓶颈）由人保证，占据由框 + 地面派生，人只做抽检与局部修正。
 *   这样占据的误差与框的误差同源 —— 框修好了，重跑派生就一起好了，
 *   不会出现"框和占据各错各的"。
 *
 * 【为什么落盘用稀疏索引 + 类别，而不是稠密位图】
 *   一帧 64 万体素，稠密 Uint8 = 640KB；实测占用率通常 3%–8%，
 *   其中 90% 是零。稀疏索引 + RLE 之后 20–60KB，且顺序解压极快。
 *   代价是随机访问要二分 —— 但随机访问只发生在"点这一格是什么"，
 *   一帧几十次，二分 5 万条是 16 次比较，可以忽略。
 *
 * 【为什么只存 occupied，不存 free/unknown】
 *   free/unknown 的语义依赖"从哪台传感器看过去"，是**观测**而不是**真值**；
 *   同一块空间换个视角结论就变了。存进真值只会让下游把"没看见"当成"空的"。
 *   所以本文件只表达"这里有东西、是什么类"，空与未知由读者按自己的口径解释。
 *   射线雕刻（DDA）因此不在这里，它是 ROI 精修的临时产物，P3 未实现。
 */
import type { OccupancyGridSpec } from '../model/document'
import type { BoxGeometryLike, Vec3 } from '../model/geometry'
import type { SourceTag, Track } from '../model/track'
import type { TrackId } from '../model/ids'
import { sampleTrack } from '../store/materialize'

/** 一帧占据。occupied 升序、labels 与之一一对应 */
export interface OccupancyFrame {
  frame: number
  /** spec 指纹：解码时校验，防止把 A 网格的 RLE 当成 B 网格用 */
  spec: string
  /** 线性索引（x-major，升序） */
  occupied: Uint32Array
  /** 与 occupied 等长，值为 classIds 下标 */
  labels: Uint8Array
  source: SourceTag
}

/** 与 Occ3D 一类公开约定常用的 200×200×16 @ 0.4m 对齐；一切从 spec 读，不写死 */
export const OCC_DEFAULTS = {
  resolution: 0.4,
  min: { x: -40, y: -40, z: -1 },
  max: { x: 40, y: 40, z: 5.4 },
} as const

export function defaultOccupancySpec(classIds: string[] = []): OccupancyGridSpec {
  const res = OCC_DEFAULTS.resolution
  return {
    resolution: res,
    origin: { ...OCC_DEFAULTS.min },
    size: {
      x: Math.round((OCC_DEFAULTS.max.x - OCC_DEFAULTS.min.x) / res),
      y: Math.round((OCC_DEFAULTS.max.y - OCC_DEFAULTS.min.y) / res),
      z: Math.round((OCC_DEFAULTS.max.z - OCC_DEFAULTS.min.z) / res),
    },
    classIds: [...classIds],
  }
}

/** 网格指纹。不算 classIds：类别表变了但几何没变时，仍应能读回旧帧 */
export function occupancySpecKey(spec: OccupancyGridSpec): string {
  const q = (v: number) => Math.round(v * 1e6) / 1e6
  const s = spec.size
  return `${q(spec.resolution)}|${s.x}x${s.y}x${s.z}|${q(spec.origin.x)},${q(spec.origin.y)},${q(spec.origin.z)}`
}

/** 规格自检。返回问题描述而不是抛错：导入外部 spec 时应该"报告并降级" */
export function validateOccupancySpec(spec: OccupancyGridSpec): string[] {
  const out: string[] = []
  const { resolution: res, size, origin, classIds } = spec
  if (!(res > 0) || !Number.isFinite(res)) out.push(`resolution 非法：${res}`)
  for (const axis of ['x', 'y', 'z'] as const) {
    const n = size?.[axis]
    if (!Number.isInteger(n) || n <= 0) out.push(`size.${axis} 必须是正整数：${n}`)
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    const v = origin?.[axis]
    if (!Number.isFinite(v)) out.push(`origin.${axis} 不是有限数：${v}`)
  }
  if (!Array.isArray(classIds)) out.push('classIds 必须是数组')
  else {
    const seen = new Set<string>()
    for (const id of classIds) {
      if (!id) out.push('classIds 里有空类别')
      else if (seen.has(id)) out.push(`classIds 重复：${id}`)
      seen.add(id)
    }
  }
  const total = voxelCount(spec)
  if (total > 100_000_000) out.push(`网格过大：${total} 体素（上限 1 亿）`)
  return out
}

export function voxelCount(spec: OccupancyGridSpec): number {
  return spec.size.x * spec.size.y * spec.size.z
}

/** 体素坐标 → 线性索引（x 最快）。越界返回 -1，不抛错 */
export function voxelToIndex(spec: OccupancyGridSpec, ix: number, iy: number, iz: number): number {
  const { x: nx, y: ny, z: nz } = spec.size
  if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return -1
  return ix + nx * (iy + ny * iz)
}

export function indexToVoxel(spec: OccupancyGridSpec, index: number): { ix: number; iy: number; iz: number } {
  const { x: nx, y: ny } = spec.size
  const iz = Math.floor(index / (nx * ny))
  const rem = index - iz * nx * ny
  const iy = Math.floor(rem / nx)
  return { ix: rem - iy * nx, iy, iz }
}

/** 体素中心的 world 坐标。所有几何判定都以中心为准（与 carving 口径一致） */
export function voxelCenter(spec: OccupancyGridSpec, index: number): Vec3 {
  const { ix, iy, iz } = indexToVoxel(spec, index)
  const res = spec.resolution
  return {
    x: spec.origin.x + (ix + 0.5) * res,
    y: spec.origin.y + (iy + 0.5) * res,
    z: spec.origin.z + (iz + 0.5) * res,
  }
}

/** world → 体素线性索引。越界返回 -1 */
export function worldToIndex(spec: OccupancyGridSpec, p: Vec3): number {
  const res = spec.resolution
  const ix = Math.floor((p.x - spec.origin.x) / res)
  const iy = Math.floor((p.y - spec.origin.y) / res)
  const iz = Math.floor((p.z - spec.origin.z) / res)
  return voxelToIndex(spec, ix, iy, iz)
}

/* ------------------------------------------------------------------
 * 地面估计
 * ------------------------------------------------------------------
 * 只为一件事服务：把"车底下的那一层体素"从占据里剪掉。
 * 框的底面常常画到地面以下 10–20cm（点云稀疏，看不见轮胎接地点），
 * 不剪的话每辆车都会在地里多出一层"幽灵体素"。
 *
 * 用低分位数而不是最小值：最小 z 一定是噪点。5% 分位对 1m 网格
 * 里 20 个点的稀疏情形仍偏保守（偏低），所以后面还要做中值滤波。
 * ------------------------------------------------------------------ */

export interface GroundField {
  cell: number
  minX: number
  minY: number
  nx: number
  ny: number
  /** NaN 表示该格没有观测 —— 没有观测就不剪，而不是当成 0 米地面 */
  height: Float32Array
  observed: number
}

export interface GroundOptions {
  cell?: number
  /** 只统计这个半径内的点（米） */
  radius?: number
  /** 每格取 z 的哪个分位 */
  quantile?: number
  /** 少于这个点数的格视为无观测 */
  minPoints?: number
  /** 中值滤波窗口（奇数），1 表示不滤波 */
  median?: number
  /** 高过这个值的点不参与地面（打到墙/树上的点） */
  maxZ?: number
}

export function estimateGround(
  cloud: { positions: Float32Array; count: number },
  opts: GroundOptions = {},
): GroundField {
  const cell = opts.cell ?? 1
  const radius = opts.radius ?? 45
  const quantile = opts.quantile ?? 0.05
  const minPoints = opts.minPoints ?? 3
  const window = Math.max(1, opts.median ?? 3)
  const maxZ = opts.maxZ ?? 3
  const half = Math.ceil(radius / cell)
  const side = half * 2
  const nx = side
  const ny = side
  const minX = -half * cell
  const minY = -half * cell

  const buckets: number[][] = Array.from({ length: nx * ny }, () => [])
  for (let i = 0; i < cloud.count; i++) {
    const x = cloud.positions[i * 3]
    const y = cloud.positions[i * 3 + 1]
    const z = cloud.positions[i * 3 + 2]
    if (!(z > -5 && z < maxZ)) continue
    if (x < minX || y < minY) continue
    const gx = Math.floor((x - minX) / cell)
    const gy = Math.floor((y - minY) / cell)
    if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) continue
    buckets[gx + nx * gy].push(z)
  }

  const raw = new Float32Array(nx * ny).fill(NaN)
  let observed = 0
  for (let i = 0; i < buckets.length; i++) {
    const list = buckets[i]
    if (list.length < minPoints) continue
    list.sort((a, b) => a - b)
    const at = Math.min(list.length - 1, Math.max(0, Math.floor(list.length * quantile)))
    raw[i] = list[at]
    observed++
  }

  const height = window > 1 ? medianFilter(raw, nx, ny, window) : raw
  return { cell, minX, minY, nx, ny, height, observed }
}

function medianFilter(src: Float32Array, nx: number, ny: number, window: number): Float32Array {
  const out = new Float32Array(src.length).fill(NaN)
  const half = Math.floor(window / 2)
  const buf: number[] = []
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = x + nx * y
      buf.length = 0
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue
          const v = src[xx + nx * yy]
          if (Number.isFinite(v)) buf.push(v)
        }
      }
      // 自身无观测但邻域有观测时也填上：填的是"邻域地面"，比"不剪"更接近真值；
      // 邻域观测不足则保持 NaN —— 宁可多留一层，不要凭空造地面。
      if (buf.length) {
        buf.sort((a, b) => a - b)
        out[i] = buf[Math.floor(buf.length / 2)]
      }
    }
  }
  return out
}

/** 查某点的地面高度；无观测返回 null（调用方据此"不剪"） */
export function groundAt(field: GroundField, x: number, y: number): number | null {
  if (!(field.cell > 0)) return null
  const gx = Math.floor((x - field.minX) / field.cell)
  const gy = Math.floor((y - field.minY) / field.cell)
  if (gx < 0 || gy < 0 || gx >= field.nx || gy >= field.ny) return null
  const v = field.height[gx + field.nx * gy]
  return Number.isFinite(v) ? v : null
}

/* ------------------------------------------------------------------
 * 派生：轨迹 → 占据
 * ------------------------------------------------------------------ */

export interface CarveOptions {
  /**
   * box-only：只用框，最快，适合"先有一份能用"的场景。
   * box+ground：用地面场剪掉框底面以下的体素（默认路径）。地面本身**不会**
   * 被写成占据，除非显式给 `groundClass` —— 理由见那个字段的注释。
   */
  mode?: 'box-only' | 'box+ground'
  ground?: GroundField | null
  /**
   * 地面类别名；给了且 spec.classIds 里有它，才会把地面铺成一层体素。
   *
   * 【默认不要给】占据训练里地面是 **free**，把它写成 occupied 会让"占用"
   *   这个标签失去意义。应用侧的派生路径不传它（见 `state/useTasks.ts`）。
   *   保留这个能力是给"路面/可行驶区域"这类**表面**任务用的，它们确实要一层地面。
   */
  groundClass?: string | null
  /**
   * 是否把 occluded / predicted 轨迹也刻进去。
   * 默认不刻：这两类帧的几何是算出来的，刻进占据会把"猜的位置"变成"真值"，
   * 而占据最常被下游当成"确实有东西"来用。
   */
  includeOccluded?: boolean
  /** 冲突裁决的类别优先级（越靠前越优先）；默认按 spec.classIds 顺序 */
  classPriority?: string[]
  source?: SourceTag
}

export interface CarveResult {
  frame: OccupancyFrame
  /** 被框覆盖的体素总数（含被多框覆盖的重复计数） */
  covered: number
  /** 被两个以上轨迹同时覆盖的体素数 */
  overlapVoxels: number
  /** 发生重叠的轨迹对（去重，上限 32 对，防止刷屏） */
  overlapPairs: Array<[TrackId, TrackId]>
  /** 没被刻进去的轨迹及原因，供 UI 解释"为什么这辆车没占格" */
  skipped: Array<{ trackId: TrackId; reason: 'no-geometry' | 'invisible' | 'unknown-class' }>
}

interface Cell {
  label: number
  volume: number
  confidence: number
  priority: number
  trackId: TrackId
}

function insideObb(g: BoxGeometryLike, p: Vec3, eps: number): boolean {
  const dx = p.x - g.position.x
  const dy = p.y - g.position.y
  const dz = p.z - g.position.z
  const c = Math.cos(g.yaw)
  const s = Math.sin(g.yaw)
  // 逆旋转：world → 框坐标系。yaw 绕 z 轴，所以 z 不变
  const lx = dx * c + dy * s
  const ly = -dx * s + dy * c
  return (
    Math.abs(lx) <= g.scale.x / 2 + eps && Math.abs(ly) <= g.scale.y / 2 + eps && Math.abs(dz) <= g.scale.z / 2 + eps
  )
}

/** 冲突裁决：体积小的赢（大框通常把旁边的东西裹进来了），再比置信度、类别优先级、id */
function beats(a: Cell, b: Cell): boolean {
  if (Math.abs(a.volume - b.volume) > 1e-6) return a.volume < b.volume
  if (Math.abs(a.confidence - b.confidence) > 1e-6) return a.confidence > b.confidence
  if (a.priority !== b.priority) return a.priority < b.priority
  return a.trackId < b.trackId
}

export function carveFromTracks(
  tracks: readonly Track[],
  frame: number,
  spec: OccupancyGridSpec,
  opts: CarveOptions = {},
): CarveResult {
  const problems = validateOccupancySpec(spec)
  if (problems.length) throw new Error(`占据规格非法：${problems.join('；')}`)

  const res = spec.resolution
  const eps = res * 1e-6
  const ground = opts.mode === 'box+ground' ? (opts.ground ?? null) : null
  const cells = new Map<number, Cell>()
  const pairs = new Map<string, [TrackId, TrackId]>()
  const skipped: CarveResult['skipped'] = []
  let covered = 0
  let overlapVoxels = 0

  const priorityOf = (classId: string): number => {
    const list = opts.classPriority
    if (list?.length) {
      const i = list.indexOf(classId)
      if (i >= 0) return i
    }
    const j = spec.classIds.indexOf(classId)
    return j >= 0 ? j : spec.classIds.length
  }

  for (const track of tracks) {
    const sampled = sampleTrack(track, frame, { mode: 'linear' })
    if (!sampled) {
      skipped.push({ trackId: track.id, reason: 'no-geometry' })
      continue
    }
    if (!opts.includeOccluded && sampled.visibility !== 'visible') {
      skipped.push({ trackId: track.id, reason: 'invisible' })
      continue
    }
    const label = spec.classIds.indexOf(track.classId)
    if (label < 0) {
      skipped.push({ trackId: track.id, reason: 'unknown-class' })
      continue
    }

    const g = sampled.geometry
    const cell: Cell = {
      label,
      volume: Math.max(1e-6, g.scale.x * g.scale.y * g.scale.z),
      confidence: sampled.confidence ?? 1,
      priority: priorityOf(track.classId),
      trackId: track.id,
    }

    // AABB → 体素范围。半宽之外再留一格：yaw 旋转后角点会超出 AABB 才会漏
    const hx = (Math.abs(g.scale.x * Math.cos(g.yaw)) + Math.abs(g.scale.y * Math.sin(g.yaw))) / 2
    const hy = (Math.abs(g.scale.x * Math.sin(g.yaw)) + Math.abs(g.scale.y * Math.cos(g.yaw))) / 2
    const hz = g.scale.z / 2
    const ix0 = Math.floor((g.position.x - hx - spec.origin.x) / res)
    const ix1 = Math.floor((g.position.x + hx - spec.origin.x) / res)
    const iy0 = Math.floor((g.position.y - hy - spec.origin.y) / res)
    const iy1 = Math.floor((g.position.y + hy - spec.origin.y) / res)
    const iz0 = Math.floor((g.position.z - hz - spec.origin.z) / res)
    const iz1 = Math.floor((g.position.z + hz - spec.origin.z) / res)

    for (let iz = iz0; iz <= iz1; iz++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const idx = voxelToIndex(spec, ix, iy, iz)
          if (idx < 0) continue
          const cx = spec.origin.x + (ix + 0.5) * res
          const cy = spec.origin.y + (iy + 0.5) * res
          const cz = spec.origin.z + (iz + 0.5) * res
          if (!insideObb(g, { x: cx, y: cy, z: cz }, eps)) continue
          covered++
          if (ground) {
            const gz = groundAt(ground, cx, cy)
            // 体素中心比地面低半格以上：整车都在地下？说明标定/地面估计有问题，
            // 这里只剪"贴地那一层"，不做大幅裁剪，避免整框被剪空变成静默失败
            if (gz !== null && cz < gz - res / 2) continue
          }
          const existing = cells.get(idx)
          if (!existing) {
            cells.set(idx, cell)
            continue
          }
          if (existing.trackId === track.id) continue
          overlapVoxels++
          const key =
            existing.trackId < track.id ? `${existing.trackId}|${track.id}` : `${track.id}|${existing.trackId}`
          if (!pairs.has(key) && pairs.size < 32) {
            pairs.set(key, existing.trackId < track.id ? [existing.trackId, track.id] : [track.id, existing.trackId])
          }
          if (beats(cell, existing)) cells.set(idx, cell)
        }
      }
    }
  }

  // ---- 地面层（可选）----
  if (ground && opts.groundClass) {
    const gLabel = spec.classIds.indexOf(opts.groundClass)
    if (gLabel >= 0) {
      const step = Math.max(1, Math.round(ground.cell / res))
      for (let gy = 0; gy < ground.ny; gy++) {
        for (let gx = 0; gx < ground.nx; gx++) {
          const h = ground.height[gx + ground.nx * gy]
          if (!Number.isFinite(h)) continue
          const wx = ground.minX + (gx + 0.5) * ground.cell
          const wy = ground.minY + (gy + 0.5) * ground.cell
          const iz = Math.floor((h - spec.origin.z) / res)
          const ix = Math.floor((wx - spec.origin.x) / res)
          const iy = Math.floor((wy - spec.origin.y) / res)
          const idx = voxelToIndex(spec, ix, iy, iz)
          if (idx < 0 || cells.has(idx)) continue
          // 一格地面拆成 step×step 个体素，否则 1m 地面网格在 0.4m 分辨率下会漏成筛子
          for (let dy = 0; dy < step; dy++) {
            for (let dx = 0; dx < step; dx++) {
              const i2 = voxelToIndex(spec, ix + dx, iy + dy, iz)
              if (i2 >= 0 && !cells.has(i2)) {
                cells.set(i2, {
                  label: gLabel,
                  volume: 0,
                  confidence: 1,
                  priority: priorityOf(opts.groundClass),
                  trackId: '__ground__',
                })
              }
            }
          }
        }
      }
    }
  }

  const indexes = [...cells.keys()].sort((a, b) => a - b)
  const occupied = new Uint32Array(indexes.length)
  const labels = new Uint8Array(indexes.length)
  for (let i = 0; i < indexes.length; i++) {
    occupied[i] = indexes[i]
    labels[i] = cells.get(indexes[i])!.label
  }

  return {
    frame: {
      frame,
      spec: occupancySpecKey(spec),
      occupied,
      labels,
      source: opts.source ?? { kind: 'derived' },
    },
    covered,
    overlapVoxels,
    overlapPairs: [...pairs.values()],
    skipped,
  }
}

/* ------------------------------------------------------------------
 * 查询与局部编辑
 * ------------------------------------------------------------------ */

/** 二分：该体素是否被占用，返回标签下标或 -1 */
export function labelAt(frame: OccupancyFrame, index: number): number {
  const arr = frame.occupied
  let lo = 0
  let hi = arr.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = arr[mid]
    if (v === index) return frame.labels[mid]
    if (v < index) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

export interface BoxOccupancy {
  /** 落在框内的体素总数 */
  covered: number
  /** 其中被占用的体素数 */
  occupied: number
  /** 类别下标 → 体素数 */
  perClass: Map<number, number>
}

/** 一个框内有多少体素被占用、分别是什么类 —— I1/I2 两个规则的唯一口径 */
export function occupiedInBox(frame: OccupancyFrame, spec: OccupancyGridSpec, box: BoxGeometryLike): BoxOccupancy {
  const res = spec.resolution
  const hx = (Math.abs(box.scale.x * Math.cos(box.yaw)) + Math.abs(box.scale.y * Math.sin(box.yaw))) / 2
  const hy = (Math.abs(box.scale.x * Math.sin(box.yaw)) + Math.abs(box.scale.y * Math.cos(box.yaw))) / 2
  const hz = box.scale.z / 2
  const ix0 = Math.floor((box.position.x - hx - spec.origin.x) / res)
  const ix1 = Math.floor((box.position.x + hx - spec.origin.x) / res)
  const iy0 = Math.floor((box.position.y - hy - spec.origin.y) / res)
  const iy1 = Math.floor((box.position.y + hy - spec.origin.y) / res)
  const iz0 = Math.floor((box.position.z - hz - spec.origin.z) / res)
  const iz1 = Math.floor((box.position.z + hz - spec.origin.z) / res)

  let covered = 0
  let occupied = 0
  const perClass = new Map<number, number>()
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const idx = voxelToIndex(spec, ix, iy, iz)
        if (idx < 0) continue
        const cx = spec.origin.x + (ix + 0.5) * res
        const cy = spec.origin.y + (iy + 0.5) * res
        const cz = spec.origin.z + (iz + 0.5) * res
        if (!insideObb(box, { x: cx, y: cy, z: cz }, res * 1e-6)) continue
        covered++
        const label = labelAt(frame, idx)
        if (label < 0) continue
        occupied++
        perClass.set(label, (perClass.get(label) ?? 0) + 1)
      }
    }
  }
  return { covered, occupied, perClass }
}

export interface VoxelEdit {
  /** 线性索引 */
  index: number
  /** 类别下标；null 表示删除 */
  label: number | null
}

/**
 * 局部编辑：只改给定的格子，其余原样。
 * 返回新帧而不是就地改 —— 命令的 before/after 必须各持一份，
 * 就地改会让撤销时读到的 before 已经被改花。
 */
export function editOccupancy(
  frame: OccupancyFrame,
  spec: OccupancyGridSpec,
  edits: readonly VoxelEdit[],
): OccupancyFrame {
  const total = voxelCount(spec)
  const map = new Map<number, number>()
  for (let i = 0; i < frame.occupied.length; i++) map.set(frame.occupied[i], frame.labels[i])
  for (const e of edits) {
    if (!Number.isInteger(e.index) || e.index < 0 || e.index >= total) continue
    if (e.label === null) map.delete(e.index)
    else if (e.label >= 0 && e.label < spec.classIds.length) map.set(e.index, e.label)
  }
  const indexes = [...map.keys()].sort((a, b) => a - b)
  const occupied = new Uint32Array(indexes.length)
  const labels = new Uint8Array(indexes.length)
  for (let i = 0; i < indexes.length; i++) {
    occupied[i] = indexes[i]
    labels[i] = map.get(indexes[i])!
  }
  return { ...frame, occupied, labels }
}

export interface OccStats {
  occupied: number
  total: number
  ratio: number
  perClass: Array<{ classId: string; count: number; ratio: number }>
}

export function occStats(frame: OccupancyFrame, spec: OccupancyGridSpec): OccStats {
  const total = voxelCount(spec)
  const counts = new Map<number, number>()
  for (const label of frame.labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  const perClass = [...counts.entries()]
    .map(([idx, count]) => ({
      classId: spec.classIds[idx] ?? `#${idx}`,
      count,
      ratio: total > 0 ? count / total : 0,
    }))
    .sort((a, b) => b.count - a.count)
  return {
    occupied: frame.occupied.length,
    total,
    ratio: total > 0 ? frame.occupied.length / total : 0,
    perClass,
  }
}

/* ------------------------------------------------------------------
 * 编解码
 * ------------------------------------------------------------------
 * RLE 布局（小端）：
 *   u32 magic 'OCC1' | u32 frame | u16 specKeyLen | specKey | u32 runCount |
 *   runCount × (u32 start | u32 length | u8 label)
 *
 * 用 (start, length) 而不是"每格一对"：一帧 5 万占用体素、几百段连续区间时，
 * 后者要 40 万字节，前者不到 4KB。类别变化处断开成两段，代价可以忽略。
 * ------------------------------------------------------------------ */

const RLE_MAGIC = 0x4f434331 // 'OCC1'
const RUN_BYTES = 9

export function encodeOccRle(frame: OccupancyFrame): ArrayBuffer {
  const runs: Array<{ start: number; len: number; label: number }> = []
  const occ = frame.occupied
  const lab = frame.labels
  for (let i = 0; i < occ.length; i++) {
    const last = runs[runs.length - 1]
    if (last && last.label === lab[i] && last.start + last.len === occ[i]) {
      last.len++
    } else {
      runs.push({ start: occ[i], len: 1, label: lab[i] })
    }
  }
  const specBytes = new TextEncoder().encode(frame.spec)
  const head = 4 + 4 + 2 + specBytes.length + 4
  const buf = new ArrayBuffer(head + runs.length * RUN_BYTES)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  let p = 0
  view.setUint32(p, RLE_MAGIC, true)
  p += 4
  view.setUint32(p, frame.frame, true)
  p += 4
  view.setUint16(p, specBytes.length, true)
  p += 2
  bytes.set(specBytes, p)
  p += specBytes.length
  view.setUint32(p, runs.length, true)
  p += 4
  for (const run of runs) {
    view.setUint32(p, run.start, true)
    p += 4
    view.setUint32(p, run.len, true)
    p += 4
    view.setUint8(p, run.label)
    p += 1
  }
  return buf
}

export function decodeOccRle(buf: ArrayBuffer): OccupancyFrame {
  if (buf.byteLength < 14) throw new Error('占据 RLE 太短')
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  let p = 0
  if (view.getUint32(p, true) !== RLE_MAGIC) throw new Error('占据 RLE magic 不匹配')
  p += 4
  const frame = view.getUint32(p, true)
  p += 4
  const specLen = view.getUint16(p, true)
  p += 2
  if (p + specLen + 4 > buf.byteLength) throw new Error('占据 RLE 头部越界')
  const spec = new TextDecoder().decode(bytes.subarray(p, p + specLen))
  p += specLen
  const runCount = view.getUint32(p, true)
  p += 4
  if (p + runCount * RUN_BYTES !== buf.byteLength) {
    throw new Error(`占据 RLE 长度不符：头部说 ${runCount} 段，实际 ${(buf.byteLength - p) / RUN_BYTES}`)
  }
  let total = 0
  for (let i = 0; i < runCount; i++) total += view.getUint32(p + i * RUN_BYTES + 4, true)
  const occupied = new Uint32Array(total)
  const labels = new Uint8Array(total)
  let at = 0
  for (let i = 0; i < runCount; i++) {
    const start = view.getUint32(p, true)
    p += 4
    const len = view.getUint32(p, true)
    p += 4
    const label = view.getUint8(p)
    p += 1
    for (let k = 0; k < len; k++) {
      occupied[at] = start + k
      labels[at] = label
      at++
    }
  }
  return { frame, spec, occupied, labels, source: { kind: 'derived' } }
}

/**
 * 一次导出多帧：header(JSON) + 各帧 RLE 拼接。
 *
 * 为什么用"一个文件 + JSON 头"而不是 npz/zip：
 *   浏览器侧不引第三方打包库，Python 侧读 JSON 头 + 切片就能进 numpy；
 *   `scripts/occ2npz.py` 只依赖 numpy，训练侧拿到 .occ 直接转。
 */
const BUNDLE_MAGIC = 'OCB1'

export function encodeOccBundle(spec: OccupancyGridSpec, frames: readonly OccupancyFrame[]): ArrayBuffer {
  const chunks = frames.map((f) => encodeOccRle(f))
  const entries = frames.map((f, i) => ({
    frame: f.frame,
    offset: chunks.slice(0, i).reduce((n, c) => n + c.byteLength, 0),
    bytes: chunks[i].byteLength,
  }))
  const header = new TextEncoder().encode(JSON.stringify({ spec, frames: entries }))
  const headLen = 4 + 4 + header.length
  const total = headLen + chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new ArrayBuffer(total)
  const view = new DataView(out)
  const bytes = new Uint8Array(out)
  bytes.set(new TextEncoder().encode(BUNDLE_MAGIC), 0)
  view.setUint32(4, header.length, true)
  bytes.set(header, 8)
  let at = headLen
  for (const c of chunks) {
    bytes.set(new Uint8Array(c), at)
    at += c.byteLength
  }
  return out
}

export function decodeOccBundle(buf: ArrayBuffer): { spec: OccupancyGridSpec; frames: OccupancyFrame[] } {
  if (buf.byteLength < 12) throw new Error('占据包太短')
  const bytes = new Uint8Array(buf)
  const magic = new TextDecoder().decode(bytes.subarray(0, 4))
  if (magic !== BUNDLE_MAGIC) throw new Error(`占据包 magic 不匹配：${magic}`)
  const view = new DataView(buf)
  const headLen = view.getUint32(4, true)
  if (8 + headLen > buf.byteLength) throw new Error('占据包头部越界')
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headLen))) as {
    spec: OccupancyGridSpec
    frames: Array<{ frame: number; offset: number; bytes: number }>
  }
  const base = 8 + headLen
  const frames = header.frames.map((e) => {
    const start = base + e.offset
    return decodeOccRle(buf.slice(start, start + e.bytes))
  })
  return { spec: header.spec, frames }
}
