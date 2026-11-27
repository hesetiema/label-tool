<script setup lang="ts">
/**
 * ============================================================
 * 正交投影视图（Top / Side / Front）
 * ============================================================
 * 对齐 CVAT 3D 的工作流：
 *   - Top：在点云上拖拽画框；选中后拖框体移动、拖角点缩放、拖旋转柄调朝向
 *   - Side / Front：拖顶部绿色圆点调高度（底面固定）
 *   - 滚轮以光标为中心缩放，中键 / 右键拖拽平移，双击最大化
 *
 * 为什么用 2D canvas 而不是再开三个 WebGL 视口：
 *   正交投影本身就是「丢掉一个坐标轴」，67k 点画一次 ImageData 比上传三份
 *   BufferGeometry 便宜得多；而且手柄命中测试直接算屏幕距离，不需要 raycast。
 *   点云图层只在「点云 / 缩放 / 平移 / 尺寸」变化时重建，拖框时零成本。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { boxToVertices } from '../core/geometry/box'
import {
  boxSizeSummary,
  convexHull,
  drawChip,
  hexToRgba,
  HOVER_GLOW,
  HOVER_TEXT,
  pointInPoly,
} from '../viewer/canvasPrimitives'
import type { Box3D, PointCloud } from '../core/types'
import { cloneBoxes } from '../core/history'
import { labelsToColors, semanticClassesOf } from '../core/semantics'
import { cloudColorsFor } from '../core/geometry/colorize'
import type { OrthoAxis, Tool } from '../state/studioCore'

const props = defineProps<{
  axis: OrthoAxis
  title: string
  cloud: PointCloud | null
  boxes: Box3D[]
  /** 主选中：手柄与标签挂在它身上 */
  selectedId: string | null
  /** 全部选中（含主选中）。多选时只有主选中显示手柄 */
  selectedIds: string[]
  /** 被锁定的对象：描边转为灰白并画一把小锁 */
  lockedIds: string[]
  /** 全局悬停对象（可能来自 3D 视口或另一个正交视图） */
  hoverId: string | null
  /** 联动缩放的广播信号；from 等于本视图时忽略，避免自己触发自己 */
  zoomSignal: { scale: number; from: OrthoAxis; nonce: number } | null
  /** 联动平移的广播信号（世界米），与 zoomSignal 同一套开关 */
  panSignal: { da: number; db: number; from: OrthoAxis; nonce: number } | null
  tool: Tool
  colorOf: (box: Box3D) => number
  /** 点云着色模式：语义标签存在时可按类别着色 */
  pointColorBy: 'default' | 'semantic' | 'intensity' | 'height'
  opacity: number
  outlinedBorders: boolean
  showOrientation: boolean
  compact?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', id: string | null): void
  (e: 'toggle', id: string): void
  (e: 'band', ids: string[]): void
  (e: 'edit', box: Box3D): void
  (e: 'editMany', boxes: Box3D[]): void
  (e: 'create', rect: { cx: number; cy: number; length: number; width: number }): void
  (e: 'maximize'): void
  /** 光标处的点云坐标，null 表示光标不在点上 */
  (e: 'cursor', p: { x: number; y: number; z: number } | null): void
  /** 悬停对象变化：由父级广播给其余视图与 3D 视口 */
  (e: 'hover', id: string | null): void
  /** 用户主动缩放：父级按需广播给其余视图 */
  (e: 'zoom', p: { from: OrthoAxis; scale: number }): void
  /** 用户平移结束：父级按需广播给其余视图（世界米，不是像素） */
  (e: 'pan', p: { from: OrthoAxis; da: number; db: number }): void
}>()

const hostRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let dpr = 1
let width = 1
let height = 1

/** 视图变换：世界 (a,b) → 屏幕。a/b 由 axis 决定 */
let cx = 0
let cy = 0
let scale = 10
let panX = 0
let panY = 0

interface Bounds {
  minA: number
  maxA: number
  minB: number
  maxB: number
}
let bounds: Bounds | null = null
let boundsCloud: PointCloud | null = null

/** 点云图层缓存 */
const cloudLayer = document.createElement('canvas')
let cloudDirty = true
/** 建层时的平移量：平移只位移这张位图，不重新逐点画 */
let layerPanX = 0
let layerPanY = 0

type DragMode = 'none' | 'move' | 'resize' | 'rotate' | 'height' | 'pan' | 'draw' | 'band'
let dragMode: DragMode = 'none'
let dragStart = { mx: 0, my: 0, wx: 0, wy: 0, wz: 0 }
let dragBox: Box3D | null = null
/** 多选拖动时的整组快照 */
let dragBoxes: Box3D[] | null = null
let dragFixed = { x: 0, y: 0 }
let dragStartYaw = 0
let dragStartAngle = 0
let dragBottomZ = 0
let draft: { a0: number; b0: number; a1: number; b1: number } | null = null
/** 橡皮筋框选的屏幕矩形 */
let bandRect: { x0: number; y0: number; x1: number; y1: number } | null = null
let hoverCursor = 'default'
/** 本视图鼠标下的框：用来驱动光标样式与「谁在指着它」的即时高亮 */
let localHoverId: string | null = null
/** 上一次广播出去的悬停值，避免同一目标被反复 emit */
let emittedHover: string | null = null
/** 拖拽中显示的尺寸提示（世界单位） */
let readout: string | null = null
let readoutAt = { x: 0, y: 0 }
/** 本次拖拽是否发生过平移（松手后要重建一次点云层，消掉位移留下的空隙） */
let panned = false
/** 平移起点（屏幕像素）：松手时用它换算出这次一共走了多少世界米 */
let panStart = { x: 0, y: 0 }
/** 光标坐标上报节流：最近邻搜索是 O(n)，不必每次 mousemove 都跑 */
let lastCursorAt = 0
/** 空白处单击的延迟取消选中：双击最大化时不能把选中状态一起清掉 */
let deselectTimer: number | undefined

const axisPair = computed<[0 | 1 | 2, 0 | 1 | 2]>(() => {
  if (props.axis === 'top') return [0, 1] // x / y
  if (props.axis === 'side') return [0, 2] // x / z
  return [1, 2] // y / z
})

const axisLabel = computed(() => {
  if (props.axis === 'top') return ['x', 'y']
  if (props.axis === 'side') return ['x', 'z']
  return ['y', 'z']
})

function component(v: { x: number; y: number; z: number }, i: 0 | 1 | 2): number {
  return i === 0 ? v.x : i === 1 ? v.y : v.z
}

/** 世界坐标 → 屏幕 CSS 像素 */
function toScreen(a: number, b: number): { x: number; y: number } {
  return {
    x: width / 2 + (a - cx) * scale + panX,
    y: height / 2 - (b - cy) * scale + panY,
  }
}

/** 屏幕 → 世界（只返回该视图平面上的两个分量） */
function toWorld(sx: number, sy: number): { a: number; b: number } {
  return {
    a: (sx - width / 2 - panX) / scale + cx,
    b: (height / 2 + panY - sy) / scale + cy,
  }
}

function pointScreen(p: { x: number; y: number; z: number }) {
  const [ia, ib] = axisPair.value
  return toScreen(component(p, ia), component(p, ib))
}

function computeBounds(cloud: PointCloud): Bounds {
  const [ia, ib] = axisPair.value
  let minA = Infinity,
    maxA = -Infinity,
    minB = Infinity,
    maxB = -Infinity
  const pos = cloud.positions
  const step = Math.max(1, Math.floor(cloud.count / 120000))
  for (let i = 0; i < cloud.count; i += step) {
    const a = pos[i * 3 + ia]
    const b = pos[i * 3 + ib]
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    if (a < minA) minA = a
    if (a > maxA) maxA = a
    if (b < minB) minB = b
    if (b > maxB) maxB = b
  }
  if (!Number.isFinite(minA)) return { minA: -10, maxA: 10, minB: -10, maxB: 10 }
  return { minA, maxA, minB, maxB }
}

function fitView() {
  if (!bounds) return
  const spanA = Math.max(bounds.maxA - bounds.minA, 4)
  const spanB = Math.max(bounds.maxB - bounds.minB, 4)
  cx = (bounds.minA + bounds.maxA) / 2
  cy = (bounds.minB + bounds.maxB) / 2
  scale = Math.min(width / spanA, height / spanB) * 0.86
  panX = 0
  panY = 0
  cloudDirty = true
  redraw()
}

function rebuildCloudLayer() {
  if (!props.cloud || !width || !height) return
  const [ia, ib] = axisPair.value
  const w = Math.max(1, Math.round(width * dpr))
  const h = Math.max(1, Math.round(height * dpr))
  if (cloudLayer.width !== w || cloudLayer.height !== h) {
    cloudLayer.width = w
    cloudLayer.height = h
  }
  const lctx = cloudLayer.getContext('2d')!
  lctx.setTransform(1, 0, 0, 1, 0, 0)
  lctx.clearRect(0, 0, w, h)
  const img = lctx.createImageData(w, h)
  const data = img.data
  const pos = props.cloud.positions

  // 语义着色：先把标签转成 rgb 查找结果（每点 3 个 0~1 值）
  const useSemantic = props.pointColorBy === 'semantic' && !!props.cloud.labels?.length
  const semanticRgb = useSemantic ? labelsToColors(props.cloud.labels!, semanticClassesOf(props.cloud)) : null
  // 强度 / 高度着色与 3D 视口共用同一套色带；缺 intensity 时自动退回默认明暗
  const rampRgb = semanticRgb ? null : (cloudColorsFor(props.cloud, props.pointColorBy) ?? null)

  // 默认模式按高度做轻微明暗，正交视图也能看出远近层次
  let minZ = Infinity,
    maxZ = -Infinity
  const stepZ = Math.max(1, Math.floor(props.cloud.count / 4000))
  for (let i = 0; i < props.cloud.count; i += stepZ) {
    const z = pos[i * 3 + 2]
    if (!Number.isFinite(z)) continue
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  if (!Number.isFinite(minZ)) {
    minZ = 0
    maxZ = 1
  }
  const zSpan = Math.max(maxZ - minZ, 0.001)

  for (let i = 0; i < props.cloud.count; i++) {
    const a = pos[i * 3 + ia]
    const b = pos[i * 3 + ib]
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    const sx = Math.round((width / 2 + (a - cx) * scale + panX) * dpr)
    const sy = Math.round((height / 2 - (b - cy) * scale + panY) * dpr)
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
    const idx = (sy * w + sx) * 4
    if (semanticRgb) {
      data[idx] = semanticRgb[i * 3] * 255
      data[idx + 1] = semanticRgb[i * 3 + 1] * 255
      data[idx + 2] = semanticRgb[i * 3 + 2] * 255
    } else if (rampRgb) {
      data[idx] = rampRgb[i * 3] * 255
      data[idx + 1] = rampRgb[i * 3 + 1] * 255
      data[idx + 2] = rampRgb[i * 3 + 2] * 255
    } else {
      const t = (pos[i * 3 + 2] - minZ) / zSpan
      const v = 120 + Math.round(t * 110)
      data[idx] = v * 0.82
      data[idx + 1] = v * 0.92
      data[idx + 2] = Math.min(255, v + 25)
    }
    data[idx + 3] = 255
  }
  lctx.putImageData(img, 0, 0)
  layerPanX = panX
  layerPanY = panY
  cloudDirty = false
}

function boxCorners(box: Box3D) {
  const hx = box.scale.x / 2
  const hy = box.scale.y / 2
  const c = Math.cos(box.yaw),
    s = Math.sin(box.yaw)
  const local: [number, number][] = [
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
    [-hx, -hy],
  ]
  return local.map(([lx, ly]) => ({
    x: box.position.x + lx * c - ly * s,
    y: box.position.y + lx * s + ly * c,
  }))
}

function selectedBox(): Box3D | null {
  return props.boxes.find((b) => b.id === props.selectedId) ?? null
}

interface Handles {
  corners: { x: number; y: number }[]
  rotate: { x: number; y: number } | null
  height: { x: number; y: number } | null
  center: { x: number; y: number }
}

/** 选中框在该视图里的手柄位置 */
function handlesOf(box: Box3D): Handles {
  if (props.axis === 'top') {
    const cs = boxCorners(box).map((p) => toScreen(p.x, p.y))
    const mid = toScreen(
      box.position.x + Math.cos(box.yaw) * (box.scale.x / 2),
      box.position.y + Math.sin(box.yaw) * (box.scale.x / 2),
    )
    const center = toScreen(box.position.x, box.position.y)
    const dx = mid.x - center.x,
      dy = mid.y - center.y
    const len = Math.hypot(dx, dy) || 1
    const rot = { x: mid.x + (dx / len) * 20, y: mid.y + (dy / len) * 20 }
    return { corners: cs, rotate: rot, height: null, center }
  }
  const verts = boxVertices(box).map(pointScreen)
  const topY = Math.min(...verts.map((p) => p.y))
  const center = pointScreen(box.position)
  return { corners: [], rotate: null, height: { x: center.x, y: topY }, center }
}

function boxVertices(box: Box3D) {
  const v = boxToVertices(box)
  const out: { x: number; y: number; z: number }[] = []
  for (let i = 0; i < 8; i++) out.push({ x: v[i * 4], y: v[i * 4 + 1], z: v[i * 4 + 2] })
  return out
}

/**
 * 框在非顶视图里的屏幕凸包。
 * 每次重绘清空、绘制时顺带填充：命中测试每移动一次鼠标要对每个框算一遍凸包，
 * 而凸包里有一次 sort——缓存后鼠标移动的开销只剩点在多边形内判断。
 */
let polyCache = new Map<string, { x: number; y: number }[]>()

function screenPoly(box: Box3D): { x: number; y: number }[] {
  const cached = polyCache.get(box.id)
  if (cached) return cached
  const poly = convexHull(boxVertices(box).map(pointScreen))
  polyCache.set(box.id, poly)
  return poly
}

/**
 * 未确认的框画虚线：预测 / 遮挡，以及待复核、已拒绝。
 * 判据与 3D 视口的 `isDashed` 保持一致 —— 两处画法不一致，
 * 用户会以为"这个框在正交图里是确定的"。
 */
function isUnconfirmed(box: Box3D): boolean {
  if (box.visibility === 'occluded' || box.visibility === 'predicted') return true
  const review = (box as Box3D & { review?: string }).review
  return review === 'pending' || review === 'rejected'
}

function drawBox(box: Box3D) {
  if (!ctx) return
  const primary = box.id === props.selectedId
  const selected = primary || props.selectedIds.includes(box.id)
  const hovered = !selected && (localHoverId === box.id || props.hoverId === box.id)
  const rgb = props.colorOf(box)
  const css = '#' + rgb.toString(16).padStart(6, '0')
  const locked = props.lockedIds.includes(box.id)
  // 主选中黄、次选中白、锁定灰、悬停只是加粗——和 CVAT 的层级一致
  const stroke = primary ? '#ffe66d' : locked ? '#9aa4b2' : selected ? '#ffffff' : css

  ctx.save()
  if (props.axis === 'top') {
    const cs = boxCorners(box).map((p) => toScreen(p.x, p.y))
    ctx.beginPath()
    cs.forEach((p, i) => (i ? ctx!.lineTo(p.x, p.y) : ctx!.moveTo(p.x, p.y)))
    ctx.closePath()
    if (!props.outlinedBorders) {
      ctx.fillStyle = hexToRgba(css, 0.1 + props.opacity * 0.12)
      ctx.fill()
    }
    ctx.strokeStyle = stroke
    ctx.lineWidth = primary ? 2 : selected ? 1.8 : hovered ? 2.2 : 1.4
    ctx.setLineDash(isUnconfirmed(box) ? [5, 4] : [])
    // 悬停光晕：单画一条更粗的浅色描边，24 个框叠在一起时也能一眼看出指着谁
    if (hovered) {
      ctx.save()
      ctx.setLineDash([])
      ctx.strokeStyle = HOVER_GLOW
      ctx.lineWidth = 5.5
      ctx.stroke()
      ctx.restore()
    }
    ctx.stroke()
    ctx.setLineDash([])
  } else {
    const poly = screenPoly(box)
    if (poly.length >= 3) {
      ctx.beginPath()
      poly.forEach((p, i) => (i ? ctx!.lineTo(p.x, p.y) : ctx!.moveTo(p.x, p.y)))
      ctx.closePath()
      ctx.fillStyle = hexToRgba(css, 0.06 + props.opacity * 0.1)
      ctx.fill()
      ctx.strokeStyle = stroke
      ctx.lineWidth = primary ? 2 : selected ? 1.8 : hovered ? 2.2 : 1.3
      ctx.setLineDash(isUnconfirmed(box) ? [5, 4] : [])
      if (hovered) {
        ctx.save()
        ctx.setLineDash([])
        ctx.strokeStyle = HOVER_GLOW
        ctx.lineWidth = 5
        ctx.stroke()
        ctx.restore()
      }
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  if (props.showOrientation) {
    const front = {
      x: box.position.x + Math.cos(box.yaw) * (box.scale.x / 2),
      y: box.position.y + Math.sin(box.yaw) * (box.scale.x / 2),
      z: box.position.z,
    }
    const c = pointScreen(box.position)
    const f = pointScreen(front)
    ctx.strokeStyle = hexToRgba(css, 0.9)
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(c.x, c.y)
    ctx.lineTo(f.x, f.y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // 多选时不画手柄：4 个角点 × N 个框会让画面变成一堆红点，且拖动语义不明确
  if (primary && props.selectedIds.length <= 1) {
    const h = handlesOf(box)
    // 角点手柄：CVAT 的红色小方块
    for (const p of h.corners) {
      ctx.fillStyle = '#ff5252'
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1
      ctx.fillRect(p.x - 4, p.y - 4, 8, 8)
      ctx.strokeRect(p.x - 4, p.y - 4, 8, 8)
    }
    // 旋转柄
    if (h.rotate && props.axis === 'top') {
      ctx.beginPath()
      ctx.arc(h.rotate.x, h.rotate.y, 5, 0, Math.PI * 2)
      ctx.fillStyle = '#ffd54f'
      ctx.fill()
      ctx.strokeStyle = '#1a1a1a'
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(h.center.x, h.center.y)
      ctx.lineTo(h.rotate.x, h.rotate.y)
      ctx.strokeStyle = hexToRgba('#ffd54f', 0.55)
      ctx.setLineDash([3, 3])
      ctx.stroke()
      ctx.setLineDash([])
    }
    // 高度柄：绿色圆点
    if (h.height) {
      ctx.beginPath()
      ctx.arc(h.height.x, h.height.y, 5, 0, Math.PI * 2)
      ctx.fillStyle = '#3ddc84'
      ctx.fill()
      ctx.strokeStyle = '#0b2a18'
      ctx.stroke()
    }
    // 标签
    const anchor = h.rotate && props.axis === 'top' ? h.rotate : h.height
    if (anchor) {
      const text = `${box.label} #${box.id}`
      ctx.font = '500 11px system-ui, sans-serif'
      const tw = ctx.measureText(text).width
      const tx = anchor.x + 8
      const ty = anchor.y - 10
      ctx.fillStyle = 'rgba(8,12,18,0.82)'
      ctx.fillRect(tx - 3, ty - 10, tw + 8, 15)
      ctx.fillStyle = '#ffe66d'
      ctx.fillText(text, tx, ty + 1)
    }
  }

  // 悬停读数：鼠标指着的框，直接把 L×W×H 与角度贴在框顶。
  // 24 个同类车框堆在一起时，「哪个是我指着的」和「它多大」应该同时得到答案。
  if (hovered) {
    const pts = props.axis === 'top' ? boxCorners(box).map((p) => toScreen(p.x, p.y)) : screenPoly(box)
    let top = pts[0]
    let minX = Infinity,
      maxX = -Infinity
    for (const p of pts) {
      if (p.y < top.y) top = p
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
    }
    // 锁定徽标也占着框顶，错开一行免得叠在一起
    const dy = locked ? -26 : -16
    drawChip(ctx, boxSizeSummary(box), (minX + maxX) / 2, top.y + dy, HOVER_TEXT, width, 'center')
  }

  // 锁定标识：画布上得能看出"拖不动"是锁住了，而不是卡了。
  // 挂在框体最上方的角点之外，避开中心的角点手柄与标签片。
  if (locked) {
    const pts =
      props.axis === 'top' ? boxCorners(box).map((p) => toScreen(p.x, p.y)) : boxVertices(box).map(pointScreen)
    let top = pts[0]
    for (const p of pts) if (p.y < top.y) top = p
    drawLock({ x: top.x, y: top.y - 11 })
  }

  ctx.restore()
}

/** 小锁徽标（矢量绘制，避免依赖 emoji 字体） */
function drawLock(p: { x: number; y: number }) {
  if (!ctx) return
  ctx.save()
  ctx.fillStyle = 'rgba(8,12,18,0.86)'
  ctx.fillRect(p.x - 7, p.y - 7, 14, 14)
  ctx.strokeStyle = 'rgba(174,186,203,0.95)'
  ctx.lineWidth = 1
  ctx.strokeRect(p.x - 6.5, p.y - 6.5, 13, 13)
  // 锁梁
  ctx.beginPath()
  ctx.arc(p.x, p.y - 1.5, 2.8, Math.PI, 0)
  ctx.stroke()
  // 锁体
  ctx.fillStyle = '#dbe4f0'
  ctx.fillRect(p.x - 3.8, p.y - 1.5, 7.6, 6)
  ctx.restore()
}

function redraw() {
  const canvas = canvasRef.value
  if (!canvas) return
  ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  // 屏幕多边形缓存的生命周期就是一次重绘：框几何一变，缓存立刻作废
  polyCache = new Map()

  // 背景 + 地面网格（1m / 5m）
  ctx.fillStyle = '#0f1219'
  ctx.fillRect(0, 0, width, height)
  if (cloudDirty) rebuildCloudLayer()
  if (cloudLayer.width) {
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    // 平移只位移整层位图：逐点写 ImageData 是 67k 次循环，拖动时不能每帧跑
    ctx.drawImage(cloudLayer, Math.round((panX - layerPanX) * dpr), Math.round((panY - layerPanY) * dpr))
    ctx.restore()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  drawGrid()

  for (const box of props.boxes) drawBox(box)

  // 拖拽预览：画框时把实时长宽标在光标旁，省掉"画完再看属性面板"
  if (draft && props.axis === 'top') {
    const p0 = toScreen(draft.a0, draft.b0)
    const p1 = toScreen(draft.a1, draft.b1)
    const rx = Math.min(p0.x, p1.x)
    const ry = Math.min(p0.y, p1.y)
    const rw = Math.abs(p1.x - p0.x)
    const rh = Math.abs(p1.y - p0.y)
    ctx.strokeStyle = '#48b0ff'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.strokeRect(rx, ry, rw, rh)
    ctx.setLineDash([])
    const L = Math.abs(draft.a1 - draft.a0)
    const W = Math.abs(draft.b1 - draft.b0)
    drawChip(ctx, `${L.toFixed(1)} × ${W.toFixed(1)} m`, p1.x + 10, p1.y - 8, '#48b0ff', width)
  }

  // 橡皮筋框选
  if (bandRect) {
    const rx = Math.min(bandRect.x0, bandRect.x1)
    const ry = Math.min(bandRect.y0, bandRect.y1)
    const rw = Math.abs(bandRect.x1 - bandRect.x0)
    const rh = Math.abs(bandRect.y1 - bandRect.y0)
    ctx.fillStyle = 'rgba(72,176,255,0.10)'
    ctx.fillRect(rx, ry, rw, rh)
    ctx.strokeStyle = 'rgba(72,176,255,0.9)'
    ctx.lineWidth = 1
    ctx.setLineDash([5, 3])
    ctx.strokeRect(rx, ry, rw, rh)
    ctx.setLineDash([])
  }

  // 拖动调高 / 缩放时的数值提示
  if (readout) drawChip(ctx, readout, readoutAt.x + 10, readoutAt.y - 8, '#3ddc84', width)

  drawScaleBar()

  // 视图角标
  if (!props.compact) {
    ctx.fillStyle = 'rgba(139,152,173,0.9)'
    ctx.font = '10px system-ui, sans-serif'
    ctx.fillText(`${props.axis.toUpperCase()}  ${axisLabel.value[0]}→  ${axisLabel.value[1]}↑`, 8, height - 8)
  }
}

/** 比例尺：网格线没有数字，靠它判断"一格是 5m 还是 50m" */
function drawScaleBar() {
  if (!ctx) return
  const options = [0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]
  let meters = options[0]
  for (const m of options) if (m * scale <= 84) meters = m
  const px = meters * scale
  const y = height - (props.compact ? 12 : 26)
  const x = 10
  ctx.save()
  ctx.strokeStyle = 'rgba(196,208,226,0.65)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, y - 4)
  ctx.lineTo(x, y)
  ctx.lineTo(x + px, y)
  ctx.lineTo(x + px, y - 4)
  ctx.stroke()
  ctx.fillStyle = 'rgba(196,208,226,0.8)'
  ctx.font = '9.5px system-ui, sans-serif'
  ctx.fillText(meters >= 1 ? `${meters} m` : `${Math.round(meters * 100)} cm`, x + px + 5, y)
  ctx.restore()
}

function drawGrid() {
  if (!ctx) return
  const [ia, ib] = axisPair.value
  const w0 = toWorld(0, height),
    w1 = toWorld(width, 0)
  const a0 = Math.ceil(w0.a),
    a1 = Math.floor(w1.a)
  const b0 = Math.ceil(w0.b),
    b1 = Math.floor(w1.b)
  const stepA = a1 - a0 > 220 ? 10 : a1 - a0 > 90 ? 5 : 1
  const stepB = b1 - b0 > 220 ? 10 : b1 - b0 > 90 ? 5 : 1
  ctx.strokeStyle = 'rgba(42,53,80,0.55)'
  ctx.lineWidth = 0.5
  ctx.beginPath()
  for (let a = a0; a <= a1; a++) {
    if (a % stepA !== 0) continue
    const p = toScreen(a, 0)
    ctx.moveTo(p.x, 0)
    ctx.lineTo(p.x, height)
  }
  for (let b = b0; b <= b1; b++) {
    if (b % stepB !== 0) continue
    const p = toScreen(0, b)
    ctx.moveTo(0, p.y)
    ctx.lineTo(width, p.y)
  }
  ctx.stroke()

  // 原点轴：x 红 / y 绿 / z 蓝，和 3D 视口的 AxesHelper 对应
  const o = toScreen(0, 0)
  ctx.strokeStyle = ia === 0 ? '#ff5252' : ia === 1 ? '#3ddc84' : '#48b0ff'
  ctx.beginPath()
  ctx.moveTo(o.x, o.y)
  ctx.lineTo(o.x + 28, o.y)
  ctx.stroke()
  ctx.strokeStyle = ib === 1 ? '#3ddc84' : ib === 2 ? '#48b0ff' : '#ff5252'
  ctx.beginPath()
  ctx.moveTo(o.x, o.y)
  ctx.lineTo(o.x, o.y - 28)
  ctx.stroke()
}

/** 命中测试：返回角点序号（0-3）、旋转、高度或框体 */
function hitTest(mx: number, my: number): { kind: DragMode; box: Box3D | null; corner: number } {
  const sel = selectedBox()
  if (sel && props.selectedIds.length <= 1) {
    const h = handlesOf(sel)
    for (let i = 0; i < h.corners.length; i++) {
      const p = h.corners[i]
      if (Math.abs(mx - p.x) <= 6 && Math.abs(my - p.y) <= 6) return { kind: 'resize', box: sel, corner: i }
    }
    if (h.rotate && Math.hypot(mx - h.rotate.x, my - h.rotate.y) <= 8) {
      return { kind: 'rotate', box: sel, corner: 0 }
    }
    if (h.height && Math.hypot(mx - h.height.x, my - h.height.y) <= 8) {
      return { kind: 'height', box: sel, corner: 0 }
    }
  }
  // 从后往前（后画的在上面）
  for (let i = props.boxes.length - 1; i >= 0; i--) {
    const box = props.boxes[i]
    if (props.axis === 'top') {
      const w = toWorld(mx, my)
      const dx = w.a - box.position.x
      const dy = w.b - box.position.y
      const c = Math.cos(-box.yaw),
        s = Math.sin(-box.yaw)
      const lx = dx * c - dy * s
      const ly = dx * s + dy * c
      if (Math.abs(lx) <= box.scale.x / 2 && Math.abs(ly) <= box.scale.y / 2) {
        return { kind: 'move', box, corner: 0 }
      }
    } else {
      const poly = screenPoly(box)
      if (pointInPoly(mx, my, poly)) return { kind: 'move', box, corner: 0 }
    }
  }
  // 三联条里场景常有 300m 宽，4.5m 的车只有一两个像素——严格的多边形命中
  // 基本点不中。退一步：离框心 5px 内也算指着它，否则小尺度下悬停/选中都是死路。
  let nearest: { box: Box3D; d: number } | null = null
  for (const box of props.boxes) {
    const c = props.axis === 'top' ? toScreen(box.position.x, box.position.y) : pointScreen(box.position)
    const d = Math.hypot(mx - c.x, my - c.y)
    if (!nearest || d < nearest.d) nearest = { box, d }
  }
  if (nearest && nearest.d <= 5) return { kind: 'move', box: nearest.box, corner: 0 }
  return { kind: 'none', box: null, corner: 0 }
}

function worldZFromScreen(my: number): number {
  return toWorld(0, my).b
}

/**
 * 上报光标处的点云坐标：在该视图平面上做最近邻，取那个点的完整 x/y/z。
 * 66k 点一次扫描约 0.3ms，再加 60ms 节流，拖动时不参与，所以不会拖慢交互。
 */
function emitCursorAt(mx: number, my: number) {
  const cloud = props.cloud
  if (!cloud) {
    emit('cursor', null)
    return
  }
  const now = performance.now()
  if (now - lastCursorAt < 60) return
  lastCursorAt = now

  const [ia, ib] = axisPair.value
  const w = toWorld(mx, my)
  const pos = cloud.positions
  const n = cloud.count
  const stride = Math.max(1, Math.floor(n / 80000))
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < n; i += stride) {
    const da = pos[i * 3 + ia] - w.a
    const db = pos[i * 3 + ib] - w.b
    const d = da * da + db * db
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  if (best < 0) {
    emit('cursor', null)
    return
  }
  // 最近点在屏幕上离光标太远，说明鼠标在空白处，别硬报一个远处的坐标
  const sp = toScreen(pos[best * 3 + ia], pos[best * 3 + ib])
  if (Math.hypot(sp.x - mx, sp.y - my) > 16) {
    emit('cursor', null)
    return
  }
  emit('cursor', { x: pos[best * 3], y: pos[best * 3 + 1], z: pos[best * 3 + 2] })
}

/** 在当前视图平面内平移一个框（只改快照，不回写） */
function shiftInPlane(box: Box3D, da: number, db: number) {
  if (props.axis === 'top') {
    box.position.x += da
    box.position.y += db
  } else if (props.axis === 'side') {
    box.position.x += da
    box.position.z += db
  } else {
    box.position.y += da
    box.position.z += db
  }
}

function clearDeselectTimer() {
  if (deselectTimer) {
    window.clearTimeout(deselectTimer)
    deselectTimer = undefined
  }
}

function beginDrag(e: MouseEvent) {
  const rect = canvasRef.value!.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  dragStart = { mx, my, wx: 0, wy: 0, wz: 0 }

  if (e.button === 1 || e.button === 2 || props.tool === 'pan') {
    dragMode = 'pan'
    panStart = { x: panX, y: panY }
    e.preventDefault()
    return
  }
  if (e.button !== 0) return

  if (props.tool === 'draw') {
    if (props.axis !== 'top') return
    const w = toWorld(mx, my)
    dragMode = 'draw'
    draft = { a0: w.a, b0: w.b, a1: w.a, b1: w.b }
    redraw()
    return
  }

  const hit = hitTest(mx, my)

  if (!hit.box) {
    // 空白处按下：左键拖 = 橡皮筋框选；只点一下 = 取消选中（在 mouseup 里判定）
    dragMode = 'band'
    bandRect = { x0: mx, y0: my, x1: mx, y1: my }
    redraw()
    return
  }

  clearDeselectTimer()

  // Ctrl / Cmd / Shift 点选：只增删选中集合，不进入拖拽
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    emit('toggle', hit.box.id)
    return
  }

  // 点在已选中的成员上且当前是多选：整体拖动，不把选择收窄成一个
  const inGroup = props.selectedIds.length > 1 && props.selectedIds.includes(hit.box.id)
  if (!inGroup) emit('select', hit.box.id)

  const w = toWorld(mx, my)
  dragStart.wx = w.a
  dragStart.wy = w.b

  if (inGroup) {
    dragMode = 'move'
    dragBoxes = JSON.parse(JSON.stringify(props.boxes.filter((b) => props.selectedIds.includes(b.id)))) as Box3D[]
    e.preventDefault()
    return
  }

  dragBox = JSON.parse(JSON.stringify(hit.box)) as Box3D

  if (hit.kind === 'resize') {
    dragMode = 'resize'
    const cs = boxCorners(hit.box)
    const opposite = cs[(hit.corner + 2) % 4]
    dragFixed = { x: opposite.x, y: opposite.y }
  } else if (hit.kind === 'rotate') {
    dragMode = 'rotate'
    dragStartYaw = hit.box.yaw
    dragStartAngle = Math.atan2(w.b - hit.box.position.y, w.a - hit.box.position.x)
  } else if (hit.kind === 'height') {
    dragMode = 'height'
    dragStart.wz = worldZFromScreen(my)
    dragBottomZ = hit.box.position.z - hit.box.scale.z / 2
  } else if (hit.kind === 'move') {
    dragMode = 'move'
  }
  e.preventDefault()
}

function onMove(e: MouseEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top

  // 四个视图都监听 window 的 mousemove：不在自己画布范围内就不做事
  if (dragMode === 'none' && (mx < 0 || my < 0 || mx > width || my > height)) {
    if (localHoverId) {
      localHoverId = null
      redraw()
    }
    return
  }

  if (dragMode === 'none') {
    const hit = hitTest(mx, my)
    let cursor = 'default'
    if (props.tool === 'pan') cursor = 'grab'
    else if (props.tool === 'draw' && props.axis === 'top') cursor = 'crosshair'
    else if (hit.kind === 'resize') cursor = 'nwse-resize'
    else if (hit.kind === 'rotate') cursor = 'crosshair'
    else if (hit.kind === 'height') cursor = 'ns-resize'
    else if (hit.kind === 'move') cursor = 'move'
    if (cursor !== hoverCursor) {
      hoverCursor = cursor
      canvas.style.cursor = cursor
    }
    // 悬停高亮：框叠在一起时先看清要选中哪个，再点下去
    const nextHover = hit.box?.id ?? null
    if (nextHover !== localHoverId) {
      localHoverId = nextHover
      redraw()
    }
    // 共享给其余视图与 3D 视口：这条线上谁在指着哪个框，全局只有一份答案
    if (localHoverId !== emittedHover) {
      emittedHover = localHoverId
      emit('hover', localHoverId)
    }
    emitCursorAt(mx, my)
    return
  }

  if (dragMode === 'pan') {
    panX += mx - dragStart.mx
    panY += my - dragStart.my
    dragStart.mx = mx
    dragStart.my = my
    // 不置 cloudDirty：平移只是位移整层位图，松手后再重建一次
    panned = true
    redraw()
    return
  }

  if (dragMode === 'draw' && draft) {
    const w = toWorld(mx, my)
    draft.a1 = w.a
    draft.b1 = w.b
    redraw()
    return
  }

  if (dragMode === 'band' && bandRect) {
    bandRect.x1 = mx
    bandRect.y1 = my
    redraw()
    return
  }

  // 多选整体平移：一次 emit 一整组，撤销栈靠 mergeKey 合成一步
  if (dragMode === 'move' && dragBoxes) {
    const w = toWorld(mx, my)
    const da = w.a - dragStart.wx
    const db = w.b - dragStart.wy
    const next = JSON.parse(JSON.stringify(dragBoxes)) as Box3D[]
    for (const b of next) shiftInPlane(b, da, db)
    readout = `Δ ${da.toFixed(1)} / ${db.toFixed(1)} m · ${next.length} 个`
    readoutAt = { x: mx, y: my }
    emit('editMany', next)
    return
  }

  if (!dragBox) return
  const start = JSON.parse(JSON.stringify(dragBox)) as Box3D
  const w = toWorld(mx, my)

  if (dragMode === 'move') {
    const da = w.a - dragStart.wx
    const db = w.b - dragStart.wy
    shiftInPlane(start, da, db)
    readout = `Δ ${da.toFixed(1)} / ${db.toFixed(1)} m`
    readoutAt = { x: mx, y: my }
  } else if (dragMode === 'resize') {
    // 以对角点为锚，把鼠标投影到框的局部 u/v 轴上求新长宽
    const c = Math.cos(dragBox.yaw),
      s = Math.sin(dragBox.yaw)
    const relX = w.a - dragFixed.x
    const relY = w.b - dragFixed.y
    const du = relX * c + relY * s
    const dv = -relX * s + relY * c
    start.scale.x = Math.max(0.25, Math.abs(du))
    start.scale.y = Math.max(0.25, Math.abs(dv))
    start.position.x = dragFixed.x + c * (du / 2) - s * (dv / 2)
    start.position.y = dragFixed.y + s * (du / 2) + c * (dv / 2)
    readout = `${start.scale.x.toFixed(1)} × ${start.scale.y.toFixed(1)} m`
    readoutAt = { x: mx, y: my }
  } else if (dragMode === 'rotate') {
    const angle = Math.atan2(w.b - dragBox.position.y, w.a - dragBox.position.x)
    let yaw = dragStartYaw + (angle - dragStartAngle)
    if (e.shiftKey) {
      const step = Math.PI / 12
      yaw = Math.round(yaw / step) * step
    }
    start.yaw = yaw
    readout = `${(((((yaw * 180) / Math.PI) % 360) + 360) % 360).toFixed(0)}°`
    readoutAt = { x: mx, y: my }
  } else if (dragMode === 'height') {
    const z = worldZFromScreen(my)
    const newH = Math.max(0.2, z - dragBottomZ)
    start.scale.z = newH
    start.position.z = dragBottomZ + newH / 2
    readout = `h ${newH.toFixed(1)} m`
    readoutAt = { x: mx, y: my }
  }

  emit('edit', start)
}

/**
 * 取消「正在画 / 正在拖」的框。返回是否真的取消了什么。
 *
 * 画框是 mouseup 时才 `emit('create')`，拖拽/缩放/旋转则是每次 mousemove 都
 * `emit('edit')` 落到父级了 —— 所以后者的"取消"必须把起始快照再提交一遍
 * （父级按 id 覆盖，等价于回滚），不能只是本地丢掉状态。
 */
function cancelDrag(): boolean {
  if (dragMode === 'none') return false
  const mode = dragMode
  if (mode === 'move' || mode === 'resize' || mode === 'rotate' || mode === 'height') {
    if (dragBoxes) emit('editMany', cloneBoxes(dragBoxes))
    else if (dragBox) emit('edit', dragBox)
  }
  draft = null
  bandRect = null
  dragMode = 'none'
  dragBox = null
  dragBoxes = null
  readout = null
  panned = false
  cloudDirty = true
  redraw()
  return true
}

/**
 * Esc：中途放弃当前这次拖拽。
 *
 * 用捕获阶段并 `stopPropagation`：全局快捷键里的 Esc 是"取消选中 + 回到选择工具"，
 * 画错一个框顺手把已选中的对象也丢了不是用户想要的。谁真有进行中的拖拽谁拦，
 * 没拖拽时一律放行，其余视图与全局行为不受影响。
 */
function onEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (cancelDrag()) e.stopPropagation()
}

function endDrag() {
  if (dragMode === 'draw' && draft) {
    const a0 = Math.min(draft.a0, draft.a1)
    const a1 = Math.max(draft.a0, draft.a1)
    const b0 = Math.min(draft.b0, draft.b1)
    const b1 = Math.max(draft.b0, draft.b1)
    const length = a1 - a0
    const width = b1 - b0
    draft = null
    if (length > 0.4 && width > 0.4) {
      emit('create', { cx: (a0 + a1) / 2, cy: (b0 + b1) / 2, length, width })
    }
  }

  if (dragMode === 'band' && bandRect) {
    const x0 = Math.min(bandRect.x0, bandRect.x1)
    const x1 = Math.max(bandRect.x0, bandRect.x1)
    const y0 = Math.min(bandRect.y0, bandRect.y1)
    const y1 = Math.max(bandRect.y0, bandRect.y1)
    bandRect = null
    const clicked = x1 - x0 < 4 && y1 - y0 < 4
    const ids: string[] = []
    if (!clicked) {
      // 用框中心判定：比「整体包住」宽容，比「碰到就算」精确
      for (const box of props.boxes) {
        const c = props.axis === 'top' ? toScreen(box.position.x, box.position.y) : pointScreen(box.position)
        if (c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1) ids.push(box.id)
      }
    }
    if (ids.length) emit('band', ids)
    else {
      // 单击空白（或框选没框到东西）：延迟取消选中，双击最大化时会被 dblclick 取消
      clearDeselectTimer()
      deselectTimer = window.setTimeout(() => emit('select', null), 220)
    }
  }

  dragMode = 'none'
  dragBox = null
  dragBoxes = null
  readout = null
  // 平移结束重建一次点云层，把位移期间露出的空白补上
  if (panned) {
    panned = false
    cloudDirty = true
    // 屏幕位移 → 世界位移：panX 增大等于视野朝 -a 方向走，
    // 广播世界米而不是像素，三联与最大化视图尺寸不同也能量得准
    const dpx = panX - panStart.x
    const dpy = panY - panStart.y
    emit('pan', { from: props.axis, da: -dpx / scale, db: dpy / scale })
  }
  redraw()
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const rect = canvasRef.value!.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  const factor = e.deltaY > 0 ? 0.88 : 1.14
  zoomAround(sx, sy, factor)
}

/** 以某个屏幕点为中心缩放，并把新的「像素/米」广播出去（联动开启时才生效） */
function zoomAround(sx: number, sy: number, factor: number) {
  const next = Math.min(600, Math.max(0.4, scale * factor))
  if (next === scale) return
  // 保持光标下的世界点不动
  const kx = sx - width / 2 - panX
  const ky = height / 2 + panY - sy
  panX = sx - width / 2 - kx * (next / scale)
  panY = sy - height / 2 + ky * (next / scale)
  scale = next
  cloudDirty = true
  redraw()
  emit('zoom', { from: props.axis, scale })
}

/** 工具条上的 +/−：以画布中心为锚 */
function zoomBy(factor: number) {
  zoomAround(width / 2, height / 2, factor)
}

/** 应用其他视图广播来的缩放：保持本视图中心不动，只改米/像素 */
function applyLinkedZoom(target: number) {
  const next = Math.min(600, Math.max(0.4, target))
  if (Math.abs(next - scale) < 0.01) return
  scale = next
  cloudDirty = true
  redraw()
}

/**
 * 应用其他视图广播来的平移：按本视图自己的「米/像素」换算成像素，
 * 保证三张图走过的是同一段世界距离，而不是同一串屏幕像素。
 */
function applyLinkedPan(da: number, db: number) {
  const before = { x: panX, y: panY }
  panX -= da * scale
  panY += db * scale
  if (Math.abs(panX - before.x) < 0.5 && Math.abs(panY - before.y) < 0.5) return
  // 平移量变了就得重建点云层：位图位移只覆盖旧内容，新露出的边缘需要重新打点
  cloudDirty = true
  redraw()
}

function onAppearanceChange() {
  redraw()
}

/** 鼠标离开画布：清掉悬停高亮和坐标，否则会一直停在最后一个值 */
function onLeave() {
  if (localHoverId) {
    localHoverId = null
    redraw()
  }
  if (emittedHover !== null) {
    emittedHover = null
    emit('hover', null)
  }
  emit('cursor', null)
}

let ro: ResizeObserver | null = null
let fitTimer: number | undefined

onMounted(() => {
  const host = hostRef.value
  const canvas = canvasRef.value
  if (!host || !canvas) return
  ctx = canvas.getContext('2d')

  ro = new ResizeObserver(() => {
    const rect = host.getBoundingClientRect()
    const nextW = Math.max(1, Math.floor(rect.width))
    const nextH = Math.max(1, Math.floor(rect.height))
    if (nextW === width && nextH === height) return
    const first = width <= 1 && height <= 1
    width = nextW
    height = nextH
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = width + 'px'
    canvas.style.height = height + 'px'
    if (first && bounds) fitView()
    else {
      cloudDirty = true
      redraw()
    }
  })
  ro.observe(host)

  canvas.addEventListener('mousedown', beginDrag)
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', endDrag)
  // 捕获阶段：见 onEscape 的注释
  window.addEventListener('keydown', onEscape, true)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('mouseleave', onLeave)
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  canvas.addEventListener('dblclick', () => {
    if (deselectTimer) {
      window.clearTimeout(deselectTimer)
      deselectTimer = undefined
    }
    emit('maximize')
  })

  // 首帧尺寸可能还没被 ResizeObserver 捕获，主动触发一次
  requestAnimationFrame(() => {
    const rect = host.getBoundingClientRect()
    if (rect.width > 0) {
      width = Math.floor(rect.width)
      height = Math.floor(rect.height)
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = width + 'px'
      canvas.style.height = height + 'px'
      if (props.cloud) {
        bounds = computeBounds(props.cloud)
        boundsCloud = props.cloud
        fitView()
      }
    }
  })
})

onBeforeUnmount(() => {
  ro?.disconnect()
  const canvas = canvasRef.value
  if (canvas) {
    canvas.removeEventListener('mousedown', beginDrag)
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('mouseleave', onLeave)
  }
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', endDrag)
  window.removeEventListener('keydown', onEscape, true)
  if (fitTimer) window.clearTimeout(fitTimer)
  if (deselectTimer) window.clearTimeout(deselectTimer)
})

watch(
  () => props.cloud,
  (next) => {
    if (next === boundsCloud) return
    boundsCloud = next
    const nextBounds = next ? computeBounds(next) : null
    const prev = bounds
    bounds = nextBounds

    // 时序逐帧切换时，各帧包围盒差异很小：保持当前缩放，避免每帧都"跳一下"。
    // 只有明显换了数据集（跨度变化 > 20% 或中心漂移过大）才重新适应。
    let keepView = false
    if (prev && nextBounds) {
      const spanOld = Math.max(prev.maxA - prev.minA, prev.maxB - prev.minB, 1)
      const spanNew = Math.max(nextBounds.maxA - nextBounds.minA, nextBounds.maxB - nextBounds.minB, 1)
      const ratio = spanNew / spanOld
      const shift = Math.hypot(
        (nextBounds.minA + nextBounds.maxA) / 2 - (prev.minA + prev.maxA) / 2,
        (nextBounds.minB + nextBounds.maxB) / 2 - (prev.minB + prev.maxB) / 2,
      )
      keepView = ratio > 0.8 && ratio < 1.25 && shift < spanOld * 0.2
    }

    cloudDirty = true
    if (next && !keepView) {
      if (fitTimer) window.clearTimeout(fitTimer)
      fitTimer = window.setTimeout(fitView, 60)
    } else {
      redraw()
    }
  },
)

// 必须 deep：拖动时 applyBox 只改框内字段，数组引用不变，浅监听收不到
watch(
  () => props.boxes,
  () => redraw(),
  { deep: true },
)
watch(
  () => props.selectedId,
  () => redraw(),
)
watch(
  () => props.selectedIds,
  () => redraw(),
)
// 别的视图（或 3D 视口）改了悬停对象：跟着高亮
watch(
  () => props.hoverId,
  () => redraw(),
)
// 联动缩放：只接受别的视图发来的信号，忽略自己那条
watch(
  () => props.zoomSignal,
  (sig) => {
    if (!sig || sig.from === props.axis) return
    applyLinkedZoom(sig.scale)
  },
)
// 联动平移：与缩放同一套规则（谁发起谁不动）
watch(
  () => props.panSignal,
  (sig) => {
    if (!sig || sig.from === props.axis) return
    applyLinkedPan(sig.da, sig.db)
  },
)
watch(
  () => props.tool,
  () => {
    localHoverId = null
    emittedHover = null
    redraw()
  },
)
watch(
  () => [props.opacity, props.outlinedBorders, props.showOrientation, props.pointColorBy],
  () => {
    cloudDirty = true
    onAppearanceChange()
  },
)
watch(
  () => props.axis,
  () => {
    bounds = props.cloud ? computeBounds(props.cloud) : null
    boundsCloud = props.cloud
    cloudDirty = true
    fitView()
  },
)
</script>

<template>
  <div ref="hostRef" class="ortho-view" :class="{ compact }">
    <canvas ref="canvasRef"></canvas>
    <div class="ortho-tools">
      <button title="最大化（双击画布）" @click.stop="emit('maximize')">⛶</button>
      <button title="适应数据" @click.stop="fitView">⤢</button>
      <button title="放大" @click.stop="zoomBy(1.25)">+</button>
      <button title="缩小" @click.stop="zoomBy(1 / 1.25)">−</button>
    </div>
    <div class="ortho-title">{{ title }}</div>
  </div>
</template>
