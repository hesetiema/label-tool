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
 */
import { ref, watch, onMounted, nextTick } from 'vue'
import type { Box3D } from '../core/types'
import type { Calibration } from '../core/calibration'
import { projectBox, BOX_EDGES } from '../core/calibration'
import { DEFAULT_CATEGORIES } from '../core/types'

const props = defineProps<{
  boxes: Box3D[]
  calib: Calibration | null
  imageUrl: string
  selectedId: string | null
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)
const imgEl = ref<HTMLImageElement | null>(null)
const visibleCount = ref(0)
let imgNaturalW = 0
let imgNaturalH = 0

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
  canvas.width = cw * dpr
  canvas.height = ch * dpr
  canvas.style.width = cw + 'px'
  canvas.style.height = ch + 'px'
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)

  // 计算" contain "缩放：图片完整放入容器，居中，留黑边
  const scale = Math.min(cw / imgNaturalW, ch / imgNaturalH)
  const drawW = imgNaturalW * scale
  const drawH = imgNaturalH * scale
  const offsetX = (cw - drawW) / 2
  const offsetY = (ch - drawH) / 2

  ctx.fillStyle = '#080a0f'
  ctx.fillRect(0, 0, cw, ch)
  ctx.drawImage(img, offsetX, offsetY, drawW, drawH)

  if (!props.calib) return
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
    const us = pts.map((p) => p.u), vs = pts.map((p) => p.v)
    if (Math.max(...us) < offsetX || Math.min(...us) > offsetX + drawW ||
        Math.max(...vs) < offsetY || Math.min(...vs) > offsetY + drawH) continue
    visible++

    const selected = box.id === props.selectedId
    const cat = DEFAULT_CATEGORIES.find((c) => c.name === box.label)
    const color = selected ? '#ffee58' : '#' + (cat?.color ?? 0x4fc3f7).toString(16).padStart(6, '0')

    ctx.strokeStyle = color
    ctx.lineWidth = selected ? 2.5 : 1.5
    // 画 12 条边
    for (const [a, b] of BOX_EDGES) {
      ctx.beginPath()
      ctx.moveTo(pts[a].u, pts[a].v)
      ctx.lineTo(pts[b].u, pts[b].v)
      ctx.stroke()
    }
    // 标签文字（取第一个角点位置）
    ctx.fillStyle = color
    ctx.font = '12px sans-serif'
    ctx.fillText(`${box.label} #${box.id}`, pts[0].u, pts[0].v - 5)
  }
  visibleCount.value = visible
}

function onImageLoad() {
  if (imgEl.value) {
    imgNaturalW = imgEl.value.naturalWidth
    imgNaturalH = imgEl.value.naturalHeight
  }
  nextTick(draw)
}

watch(() => [props.boxes, props.calib, props.selectedId], () => nextTick(draw), { deep: true })
onMounted(() => { if (imgEl.value?.complete) onImageLoad() })

defineExpose({ redraw: draw })
</script>

<template>
  <div ref="containerRef" class="camera-view">
    <img
      ref="imgEl"
      :src="imageUrl"
      alt="相机图像"
      crossorigin="anonymous"
      @load="onImageLoad"
      style="display: none"
    />
    <canvas ref="canvasRef"></canvas>
    <div class="cam-hud">
      <span class="cam-tag">前视相机 · FRONT</span>
      <span class="cam-count">{{ visibleCount }} 个框可见</span>
    </div>
  </div>
</template>

<style scoped>
.camera-view { position: relative; width: 100%; height: 100%; overflow: hidden; background: #080a0f; }
.camera-view canvas { display: block; }
.cam-hud { position: absolute; top: 10px; left: 10px; display: flex; gap: 8px; pointer-events: none; }
.cam-tag { background: rgba(91,224,160,.15); color: #5ce0a0; border: 1px solid rgba(91,224,160,.4); padding: 4px 9px; border-radius: 4px; font-size: 11px; }
.cam-count { background: rgba(0,0,0,.5); color: #8b98ad; padding: 4px 9px; border-radius: 4px; font-size: 11px; }
</style>
