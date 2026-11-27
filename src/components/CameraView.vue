<script setup lang="ts">
/**
 * ============================================================
 * 相机图像视图 —— 3D 框投影到 2D 图像的可视化
 * ============================================================
 *
 * 这是 docs/06 理论 + core/calibration.ts 算法的可视化落地：
 *   1) canvas 画相机图片作为背景
 *   2) 把每个 3D 框的 8 角点投影成像素坐标
 *   3) 按 12 条边连线，画出彩色线框
 *   4) 图片坐标系 → canvas 显示坐标系的缩放映射
 *
 * 关键细节：图片是 2048×1536，但 canvas 显示区域较小，需要按比例缩放；
 * 同时把投影点从"图片像素坐标"换算到"canvas 坐标"。
 *
 * 悬停与正交视图共用同一份 hoverId：在这张图上指着一个框，
 * 3D 视口与三联视图同时亮同一个——四处看到的必须是同一个答案。
 */
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import type { Calibration } from '../core/io/calibration'
import { projectBox, BOX_EDGES } from '../core/io/calibration'
import type { Box3D } from '../core/types'
import { boxSizeSummary, convexHull, drawChip, HOVER_GLOW, HOVER_TEXT, pointInPoly } from '../viewer/canvasPrimitives'

const props = defineProps<{
  boxes: Box3D[]
  calib: Calibration | null
  imageUrl: string
  selectedId: string | null
  /** 全局悬停对象（可能来自 3D 视口或任一正交视图） */
  hoverId: string | null
  colorOf: (box: Box3D) => number
  colorKey: string
}>()

const emit = defineEmits<{
  (e: 'hover', id: string | null): void
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)
const imgEl = ref<HTMLImageElement | null>(null)
const visibleCount = ref(0)
let imgNaturalW = 0
let imgNaturalH = 0

/** 本视图鼠标下的框 */
let localHover: string | null = null
/** 上一次广播出去的悬停值，避免同一目标被反复 emit */
let emittedHover: string | null = null
/**
 * 上一次重绘时读到的 props.hoverId。
 * 用它而不是 localHover 判断「要不要重绘」：本地刚清空悬停时两个值都是 null，
 * 但画布上还留着旧光晕——按 localHover 比较就会漏掉这一帧，光晕一直不消失。
 */
let drawnHover: string | null = null

/**
 * 拾取缓存：重绘时把每个框的屏幕凸包存下来。
 * mousemove 每秒几十次，不能每次都重投影 8 个角点 + 求凸包（含一次 sort）。
 */
interface PickItem {
  id: string
  poly: { x: number; y: number }[]
  top: number
  left: number
  right: number
}
let pickList: PickItem[] = []

/** 重绘：图片 + 所有投影框 */
function draw() {
  const canvas = canvasRef.value
  const container = containerRef.value
  const img = imgEl.value
  if (!canvas || !container || !img || !img.complete || !imgNaturalW) return

  // canvas 分辨率跟随显示尺寸（用 devicePixelRatio 保证清晰）
  const dpr = Math.min(window.devicePixelRatio, 2)
  const cw = container.clientWidth
  const ch = container.clientHeight
  const pxW = Math.round(cw * dpr)
  const pxH = Math.round(ch * dpr)
  // 尺寸不变就别重设 canvas.width：赋值会清空画布并重置变换，
  // 悬停（鼠标每掠过一格重绘一次）时白闪一下
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW
    canvas.height = pxH
    canvas.style.width = cw + 'px'
    canvas.style.height = ch + 'px'
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  // 计算" contain "缩放：图片完整放入容器，居中，留黑边
  const scale = Math.min(cw / imgNaturalW, ch / imgNaturalH)
  const drawW = imgNaturalW * scale
  const drawH = imgNaturalH * scale
  const offsetX = (cw - drawW) / 2
  const offsetY = (ch - drawH) / 2

  ctx.fillStyle = '#080a0f'
  ctx.fillRect(0, 0, cw, ch)
  ctx.drawImage(img, offsetX, offsetY, drawW, drawH)

  pickList = []
  if (!props.calib) {
    visibleCount.value = 0
    return
  }
  let visible = 0

  for (const box of props.boxes) {
    // 3D 框 8 角点 → 图片像素坐标
    const proj = projectBox(box, props.calib)
    if (!proj) continue // 相机后方的框，跳过

    // 先把像素坐标换算到 canvas 显示坐标
    const pts = proj.map((p) => ({
      u: offsetX + p.u * scale,
      v: offsetY + p.v * scale,
    }))

    // 判断框是否大致在图像范围内（避免画到黑边上）
    const us = pts.map((p) => p.u),
      vs = pts.map((p) => p.v)
    if (
      Math.max(...us) < offsetX ||
      Math.min(...us) > offsetX + drawW ||
      Math.max(...vs) < offsetY ||
      Math.min(...vs) > offsetY + drawH
    )
      continue
    visible++

    const selected = box.id === props.selectedId
    const hovered = !selected && (box.id === localHover || box.id === props.hoverId)
    const color = selected ? '#ffee58' : '#' + props.colorOf(box).toString(16).padStart(6, '0')

    // 命中轮廓：8 个投影点的屏幕凸包（与正交视图同一套算法）
    const screenPts = pts.map((p) => ({ x: p.u, y: p.v }))
    const poly = convexHull(screenPts)
    let top = screenPts[0],
      left = Infinity,
      right = -Infinity
    for (const p of screenPts) {
      if (p.y < top.y) top = p
      if (p.x < left) left = p.x
      if (p.x > right) right = p.x
    }
    pickList.push({ id: box.id, poly, top: top.y, left, right })

    // 悬停光晕：先画粗的浅色边，再画本色边，视觉上与正交视图一致
    const traceEdges = () => {
      ctx.beginPath()
      for (const [a, b] of BOX_EDGES) {
        ctx.moveTo(pts[a].u, pts[a].v)
        ctx.lineTo(pts[b].u, pts[b].v)
      }
    }
    if (hovered) {
      traceEdges()
      ctx.save()
      ctx.strokeStyle = HOVER_GLOW
      ctx.lineWidth = 5
      ctx.stroke()
      ctx.restore()
    }
    traceEdges()
    ctx.strokeStyle = color
    ctx.lineWidth = selected ? 2.5 : hovered ? 2.2 : 1.5
    if (box.visibility === 'occluded' || box.visibility === 'predicted') ctx.setLineDash([5, 4])
    ctx.stroke()
    ctx.setLineDash([])

    // 标签文字（取第一个角点位置）
    ctx.fillStyle = color
    ctx.font = '12px sans-serif'
    ctx.fillText(`${box.label} #${box.id}`, pts[0].u, pts[0].v - 5)

    // 悬停读数：尺寸摘要贴在框顶，不用回头去看右侧属性面板
    if (hovered) {
      drawChip(ctx, boxSizeSummary(box), (left + right) / 2, top.y - 24, HOVER_TEXT, cw, 'center')
    }
  }
  visibleCount.value = visible
  drawnHover = props.hoverId
}

function onImageLoad() {
  if (imgEl.value) {
    imgNaturalW = imgEl.value.naturalWidth
    imgNaturalH = imgEl.value.naturalHeight
  }
  nextTick(draw)
}

/**
 * 悬停拾取：从后往前扫（后画的在上面），命中即止。
 * 只跑在缓存的多边形上，一帧最多几十个点，不会拖慢鼠标。
 */
function onMove(e: MouseEvent) {
  const container = containerRef.value
  if (!container) return
  const rect = container.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) return

  let next: string | null = null
  for (let i = pickList.length - 1; i >= 0; i--) {
    if (pointInPoly(mx, my, pickList[i].poly)) {
      next = pickList[i].id
      break
    }
  }
  if (next !== localHover) {
    localHover = next
    draw()
  }
  if (next !== emittedHover) {
    emittedHover = next
    emit('hover', next)
  }
}

function onLeave() {
  if (localHover) {
    localHover = null
    draw()
  }
  if (emittedHover !== null) {
    emittedHover = null
    emit('hover', null)
  }
}

watch(
  () => [props.boxes, props.calib, props.selectedId, props.colorKey],
  () => nextTick(draw),
  { deep: true },
)
// 别处（3D 视口 / 正交视图）改了悬停：跟着高亮，但不再广播回去。
// 本地刚发出的那次悬停已经画过了，靠 drawnHover 跳过这一帧的重复重绘。
watch(
  () => props.hoverId,
  (id) => {
    if (id !== drawnHover) draw()
  },
)

let ro: ResizeObserver | null = null

onMounted(() => {
  if (imgEl.value?.complete) onImageLoad()
  const container = containerRef.value
  container?.addEventListener('mousemove', onMove)
  container?.addEventListener('mouseleave', onLeave)
  // 容器尺寸变化时 props 不会动，得自己重绘，否则图会被拉扁
  if (container) {
    ro = new ResizeObserver(() => draw())
    ro.observe(container)
  }
})
onBeforeUnmount(() => {
  ro?.disconnect()
  const container = containerRef.value
  container?.removeEventListener('mousemove', onMove)
  container?.removeEventListener('mouseleave', onLeave)
})

defineExpose({ redraw: draw })
</script>

<template>
  <div ref="containerRef" class="camera-view">
    <img ref="imgEl" :src="imageUrl" alt="相机图像" crossorigin="anonymous" style="display: none" @load="onImageLoad" />
    <canvas ref="canvasRef"></canvas>
    <div class="cam-hud">
      <span class="cam-tag">前视相机 · FRONT</span>
      <span class="cam-count">{{ visibleCount }} 个框可见</span>
    </div>
  </div>
</template>

<style scoped>
.camera-view {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #080a0f;
}
.camera-view canvas {
  display: block;
}
.cam-hud {
  position: absolute;
  top: 10px;
  left: 10px;
  display: flex;
  gap: 8px;
  pointer-events: none;
}
.cam-tag {
  background: rgba(91, 224, 160, 0.15);
  color: #5ce0a0;
  border: 1px solid rgba(91, 224, 160, 0.4);
  padding: 4px 9px;
  border-radius: 4px;
  font-size: 11px;
}
.cam-count {
  background: rgba(0, 0, 0, 0.5);
  color: #8b98ad;
  padding: 4px 9px;
  border-radius: 4px;
  font-size: 11px;
}
</style>
