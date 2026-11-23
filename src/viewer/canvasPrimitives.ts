/**
 * ============================================================
 * 2D canvas 共用绘制/命中工具
 * ============================================================
 *
 * 三联正交视图与相机投影视图是两套独立的 canvas，但要做同一件事：
 *   把框的投影点连成多边形 → 判断鼠标落在哪个框里 → 在框旁贴一个读数标签。
 *
 * 抽到这里是为了「一致性」：同一个框在两张画布上应该长得一样、
 * 命中判定的宽容度也应该一样。避免两处各抄一份后慢慢跑偏。
 */
import type { Box3D } from '../core/types'

export interface Pt {
  x: number
  y: number
}

/** 轴对齐凸包（Andrew monotone chain），用于把 8 个角点压成屏幕轮廓 */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y)
  if (pts.length < 3) return pts
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Pt[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop(); lower.pop()
  return lower.concat(upper)
}

/** 射线法：点是否在多边形内 */
export function pointInPoly(x: number, y: number, poly: Pt[]): boolean {
  if (poly.length < 3) return false
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y
    const xj = poly[j].x, yj = poly[j].y
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * 尺寸摘要：`4.5 × 1.9 × 1.6 m · 12°`。
 * 与属性面板显示同一组数字，悬停时不用移开视线去右侧找。
 */
export function boxSizeSummary(box: Box3D, withYaw = true): string {
  const s = box.scale
  const base = `${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} m`
  if (!withYaw) return base
  const deg = ((((box.yaw * 180) / Math.PI) % 360) + 360) % 360
  return `${base} · ${deg.toFixed(0)}°`
}

/**
 * 深底亮字的小标签：点云背景很杂，没有底色读不清。
 * @param right 画布右边界，用来把贴边标签往回收
 */
export function drawChip(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  right = Number.POSITIVE_INFINITY,
  align: 'left' | 'center' = 'left',
) {
  ctx.save()
  ctx.font = '500 11px system-ui, sans-serif'
  const tw = ctx.measureText(text).width
  const bx = Math.max(2, Math.min(align === 'center' ? x - tw / 2 : x, right - tw - 12))
  const by = Math.max(2, y - 11)
  ctx.fillStyle = 'rgba(8,12,18,0.86)'
  ctx.fillRect(bx - 4, by, tw + 9, 16)
  ctx.strokeStyle = hexToRgba(color, 0.45)
  ctx.lineWidth = 1
  ctx.strokeRect(bx - 4.5, by + 0.5, tw + 10, 15)
  ctx.fillStyle = color
  ctx.fillText(text, bx, by + 12)
  ctx.restore()
}

export function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/** 悬停光晕的统一配色：3D / 正交 / 相机三处必须一致，否则"同一次悬停"看起来像三件事 */
export const HOVER_GLOW = 'rgba(125,224,255,0.5)'
export const HOVER_TEXT = '#7de0ff'
