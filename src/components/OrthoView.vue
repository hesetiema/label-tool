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
import type { Box3D, PointCloud } from '../core/types'
import type { OrthoAxis, Tool } from '../state/studioCore'

const props = defineProps<{
  axis: OrthoAxis
  title: string
  cloud: PointCloud | null
  boxes: Box3D[]
  selectedId: string | null
  tool: Tool
  colorOf: (box: Box3D) => number
  opacity: number
  outlinedBorders: boolean
  showOrientation: boolean
  compact?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', id: string | null): void
  (e: 'edit', box: Box3D): void
  (e: 'create', rect: { cx: number; cy: number; length: number; width: number }): void
  (e: 'maximize'): void
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

interface Bounds { minA: number; maxA: number; minB: number; maxB: number }
let bounds: Bounds | null = null
let boundsCloud: PointCloud | null = null

/** 点云图层缓存 */
const cloudLayer = document.createElement('canvas')
let cloudDirty = true

type DragMode = 'none' | 'move' | 'resize' | 'rotate' | 'height' | 'pan' | 'draw'
let dragMode: DragMode = 'none'
let dragStart = { mx: 0, my: 0, wx: 0, wy: 0, wz: 0 }
let dragBox: Box3D | null = null
let dragFixed = { x: 0, y: 0 }
let dragStartYaw = 0
let dragStartAngle = 0
let dragBottomZ = 0
let draft: { a0: number; b0: number; a1: number; b1: number } | null = null
let hoverCursor = 'default'
/** 空白处单击的延迟取消选中：双击最大化时不能把选中状态一起清掉 */
let deselectTimer: number | undefined

const axisPair = computed<[0 | 1 | 2, 0 | 1 | 2]>(() => {
  if (props.axis === 'top') return [0, 1]   // x / y
  if (props.axis === 'side') return [0, 2]  // x / z
  return [1, 2]                             // y / z
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
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity
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

  // 按高度做轻微明暗，正交视图也能看出远近层次
  let minZ = Infinity, maxZ = -Infinity
  const stepZ = Math.max(1, Math.floor(props.cloud.count / 4000))
  for (let i = 0; i < props.cloud.count; i += stepZ) {
    const z = pos[i * 3 + 2]
    if (!Number.isFinite(z)) continue
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  if (!Number.isFinite(minZ)) { minZ = 0; maxZ = 1 }
  const zSpan = Math.max(maxZ - minZ, 0.001)

  for (let i = 0; i < props.cloud.count; i++) {
    const a = pos[i * 3 + ia]
    const b = pos[i * 3 + ib]
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    const sx = Math.round((width / 2 + (a - cx) * scale + panX) * dpr)
    const sy = Math.round((height / 2 - (b - cy) * scale + panY) * dpr)
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
    const t = (pos[i * 3 + 2] - minZ) / zSpan
    const v = 120 + Math.round(t * 110)
    const idx = (sy * w + sx) * 4
    data[idx] = v * 0.82
    data[idx + 1] = v * 0.92
    data[idx + 2] = Math.min(255, v + 25)
    data[idx + 3] = 255
  }
  lctx.putImageData(img, 0, 0)
  cloudDirty = false
}

function hull(points: { x: number; y: number }[]) {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y)
  if (pts.length < 3) return pts
  const cross = (o: any, a: any, b: any) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: any[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: any[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop(); lower.pop()
  return lower.concat(upper)
}

function boxCorners(box: Box3D) {
  const hx = box.scale.x / 2
  const hy = box.scale.y / 2
  const c = Math.cos(box.yaw), s = Math.sin(box.yaw)
  const local: [number, number][] = [[hx, -hy], [hx, hy], [-hx, hy], [-hx, -hy]]
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
    const dx = mid.x - center.x, dy = mid.y - center.y
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

function drawBox(box: Box3D) {
  if (!ctx) return
  const selected = box.id === props.selectedId
  const rgb = props.colorOf(box)
  const css = '#' + rgb.toString(16).padStart(6, '0')

  ctx.save()
  if (props.axis === 'top') {
    const cs = boxCorners(box).map((p) => toScreen(p.x, p.y))
    ctx.beginPath()
    cs.forEach((p, i) => (i ? ctx!.lineTo(p.x, p.y) : ctx!.moveTo(p.x, p.y)))
    ctx.closePath()
    if (!props.outlinedBorders) {
      ctx.fillStyle = hexToRgba(css, 0.10 + props.opacity * 0.12)
      ctx.fill()
    }
    ctx.strokeStyle = selected ? '#ffe66d' : css
    ctx.lineWidth = selected ? 2 : 1.4
    ctx.setLineDash(box.visibility === 'occluded' || box.visibility === 'predicted' ? [5, 4] : [])
    ctx.stroke()
    ctx.setLineDash([])
  } else {
    const verts = boxVertices(box).map(pointScreen)
    const poly = hull(verts)
    if (poly.length >= 3) {
      ctx.beginPath()
      poly.forEach((p, i) => (i ? ctx!.lineTo(p.x, p.y) : ctx!.moveTo(p.x, p.y)))
      ctx.closePath()
      ctx.fillStyle = hexToRgba(css, 0.06 + props.opacity * 0.10)
      ctx.fill()
      ctx.strokeStyle = selected ? '#ffe66d' : css
      ctx.lineWidth = selected ? 2 : 1.3
      ctx.setLineDash(box.visibility === 'occluded' || box.visibility === 'predicted' ? [5, 4] : [])
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

  if (selected) {
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

  ctx.restore()
}

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

function redraw() {
  const canvas = canvasRef.value
  if (!canvas) return
  ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  // 背景 + 地面网格（1m / 5m）
  ctx.fillStyle = '#0f1219'
  ctx.fillRect(0, 0, width, height)
  if (cloudDirty) rebuildCloudLayer()
  if (cloudLayer.width) {
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(cloudLayer, 0, 0)
    ctx.restore()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  drawGrid()

  for (const box of props.boxes) drawBox(box)

  // 拖拽预览
  if (draft && props.axis === 'top') {
    const p0 = toScreen(draft.a0, draft.b0)
    const p1 = toScreen(draft.a1, draft.b1)
    ctx.strokeStyle = '#48b0ff'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.strokeRect(Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y))
    ctx.setLineDash([])
  }

  // 视图角标
  if (!props.compact) {
    ctx.fillStyle = 'rgba(139,152,173,0.9)'
    ctx.font = '10px system-ui, sans-serif'
    ctx.fillText(`${props.axis.toUpperCase()}  ${axisLabel.value[0]}→  ${axisLabel.value[1]}↑`, 8, height - 8)
  }
}

function drawGrid() {
  if (!ctx) return
  const [ia, ib] = axisPair.value
  const w0 = toWorld(0, height), w1 = toWorld(width, 0)
  const a0 = Math.ceil(w0.a), a1 = Math.floor(w1.a)
  const b0 = Math.ceil(w0.b), b1 = Math.floor(w1.b)
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
  ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + 28, o.y); ctx.stroke()
  ctx.strokeStyle = ib === 1 ? '#3ddc84' : ib === 2 ? '#48b0ff' : '#ff5252'
  ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x, o.y - 28); ctx.stroke()
}

/** 命中测试：返回角点序号（0-3）、旋转、高度或框体 */
function hitTest(mx: number, my: number): { kind: DragMode; box: Box3D | null; corner: number } {
  const sel = selectedBox()
  if (sel) {
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
      const c = Math.cos(-box.yaw), s = Math.sin(-box.yaw)
      const lx = dx * c - dy * s
      const ly = dx * s + dy * c
      if (Math.abs(lx) <= box.scale.x / 2 && Math.abs(ly) <= box.scale.y / 2) {
        return { kind: 'move', box, corner: 0 }
      }
    } else {
      const poly = hull(boxVertices(box).map(pointScreen))
      if (pointInPoly(mx, my, poly)) return { kind: 'move', box, corner: 0 }
    }
  }
  return { kind: 'none', box: null, corner: 0 }
}

function pointInPoly(x: number, y: number, poly: { x: number; y: number }[]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y
    const xj = poly[j].x, yj = poly[j].y
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function worldZFromScreen(my: number): number {
  return toWorld(0, my).b
}

function beginDrag(e: MouseEvent) {
  const rect = canvasRef.value!.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  dragStart = { mx, my, wx: 0, wy: 0, wz: 0 }

  if (e.button === 1 || e.button === 2 || props.tool === 'pan') {
    dragMode = 'pan'
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
    // 延迟 220ms：如果紧接着是双击（最大化），就取消这次取消选中
    if (deselectTimer) window.clearTimeout(deselectTimer)
    deselectTimer = window.setTimeout(() => emit('select', null), 220)
    return
  }
  if (deselectTimer) { window.clearTimeout(deselectTimer); deselectTimer = undefined }
  emit('select', hit.box.id)

  const w = toWorld(mx, my)
  dragStart.wx = w.a
  dragStart.wy = w.b
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
    return
  }

  if (dragMode === 'pan') {
    panX += mx - dragStart.mx
    panY += my - dragStart.my
    dragStart.mx = mx
    dragStart.my = my
    cloudDirty = true
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

  if (!dragBox) return
  const start = JSON.parse(JSON.stringify(dragBox)) as Box3D
  const w = toWorld(mx, my)

  if (dragMode === 'move') {
    const da = w.a - dragStart.wx
    const db = w.b - dragStart.wy
    if (props.axis === 'top') {
      start.position.x += da
      start.position.y += db
    } else if (props.axis === 'side') {
      start.position.x += da
      start.position.z += db
    } else {
      start.position.y += da
      start.position.z += db
    }
  } else if (dragMode === 'resize') {
    // 以对角点为锚，把鼠标投影到框的局部 u/v 轴上求新长宽
    const c = Math.cos(dragBox.yaw), s = Math.sin(dragBox.yaw)
    const relX = w.a - dragFixed.x
    const relY = w.b - dragFixed.y
    const du = relX * c + relY * s
    const dv = -relX * s + relY * c
    start.scale.x = Math.max(0.25, Math.abs(du))
    start.scale.y = Math.max(0.25, Math.abs(dv))
    start.position.x = dragFixed.x + c * (du / 2) - s * (dv / 2)
    start.position.y = dragFixed.y + s * (du / 2) + c * (dv / 2)
  } else if (dragMode === 'rotate') {
    const angle = Math.atan2(w.b - dragBox.position.y, w.a - dragBox.position.x)
    let yaw = dragStartYaw + (angle - dragStartAngle)
    if (e.shiftKey) { const step = Math.PI / 12; yaw = Math.round(yaw / step) * step }
    start.yaw = yaw
  } else if (dragMode === 'height') {
    const z = worldZFromScreen(my)
    const newH = Math.max(0.2, z - dragBottomZ)
    start.scale.z = newH
    start.position.z = dragBottomZ + newH / 2
  }

  emit('edit', start)
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
  dragMode = 'none'
  dragBox = null
  redraw()
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const rect = canvasRef.value!.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  const factor = e.deltaY > 0 ? 0.88 : 1.14
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
}

function onAppearanceChange() {
  cloudDirty = true
  redraw()
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
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  canvas.addEventListener('dblclick', () => {
    if (deselectTimer) { window.clearTimeout(deselectTimer); deselectTimer = undefined }
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
  }
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', endDrag)
  if (fitTimer) window.clearTimeout(fitTimer)
  if (deselectTimer) window.clearTimeout(deselectTimer)
})

watch(() => props.cloud, (next) => {
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
})

watch(() => props.boxes, () => redraw())
watch(() => props.selectedId, () => redraw())
watch(() => [props.opacity, props.outlinedBorders, props.showOrientation], onAppearanceChange)
watch(() => props.axis, () => {
  bounds = props.cloud ? computeBounds(props.cloud) : null
  boundsCloud = props.cloud
  cloudDirty = true
  fitView()
})
</script>

<template>
  <div ref="hostRef" class="ortho-view" :class="{ compact }">
    <canvas ref="canvasRef"></canvas>
    <div class="ortho-tools">
      <button title="最大化（双击画布）" @click.stop="emit('maximize')">⛶</button>
      <button title="适应数据" @click.stop="fitView">⤢</button>
      <button title="放大" @click.stop="scale = Math.min(600, scale * 1.25); cloudDirty = true; redraw()">+</button>
      <button title="缩小" @click.stop="scale = Math.max(0.4, scale / 1.25); cloudDirty = true; redraw()">−</button>
    </div>
    <div class="ortho-title">{{ title }}</div>
  </div>
</template>
