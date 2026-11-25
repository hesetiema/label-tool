<script setup lang="ts">
/**
 * ============================================================
 * 轨迹时间线
 * ============================================================
 *
 * 横轴是帧，纵轴是轨迹。它回答 4D 标注里最常问的三个问题：
 *   "这条轨迹从哪帧到哪帧" / "哪些帧是人标的、哪些是插值" / "现在这几帧空着是不是漏标"
 *
 * 交互：
 *   - 单击轨迹名 → 选中并跳到首个关键帧
 *   - Ctrl/⌘ 单击 → 多选（用于合并）
 *   - 单击条形 → 跳到该帧
 *   - 双击条形 → 在该帧补一个关键帧（几何由相邻关键帧插值推断）
 *
 * 【性能取舍】
 *   关键帧刻度按 0.5% 分桶渲染，一帧密集标注（500 帧）也只产生 ≤200 个刻度；
 *   行数超过 60 时只渲染前 60 条并提示剩余数量 —— 时间线是导航工具，
 *   不是全量数据表，没必要为 200 条轨迹铺 4 万个 DOM 节点。
 */
import { computed, inject, onBeforeUnmount, ref } from 'vue'
import { StudioKey } from '../state/studioContext'

const studio = inject(StudioKey)!
const {
  frames, store, doc, docVersion, selectedIds, selectedId,
  selectBox, toggleSelectBox, gotoFrameIndex, frameNumber,
  addKeyframeAt, splitSelectedAt, mergeSelectedTracks, doInterpolate,
  setTrackLifecycle, deleteSelected, toggleHidden, toggleLocked, isLocked,
} = studio

const open = defineModel<boolean>('open', { default: true })
const MAX_ROWS = 60

interface Row {
  id: string
  label: string
  first: number
  last: number
  keyframes: number[]
  ticks: number[]
  selected: boolean
}

const range = computed<[number, number]>(() => doc.value?.range ?? [0, 0])
const span = computed(() => Math.max(1, range.value[1] - range.value[0]))
const frameNo = computed(() => frameNumber())

function pct(frame: number): number {
  return ((frame - range.value[0]) / span.value) * 100
}

const rows = computed<Row[]>(() => {
  // 显式依赖修订号：TrackStore 是裸对象，不读 docVersion 就不会重算
  void docVersion.value
  const s = store.value
  if (!s) return []
  const selected = selectedIds.value
  return s.tracks
    .slice()
    .sort((a, b) => a.lifecycle.first - b.lifecycle.first || a.id.localeCompare(b.id, 'en', { numeric: true }))
    .map((t) => {
      const tickSet = new Set<number>()
      for (const kf of t.keyframes) tickSet.add(Math.round(pct(kf.frame) * 2) / 2)
      return {
        id: t.id,
        label: t.classId,
        first: t.lifecycle.first,
        last: t.lifecycle.last,
        keyframes: t.keyframes.map((k) => k.frame),
        ticks: [...tickSet].sort((a, b) => a - b),
        selected: selected.has(t.id),
      }
    })
})

const visibleRows = computed(() => rows.value.slice(0, MAX_ROWS))
const hiddenCount = computed(() => Math.max(0, rows.value.length - MAX_ROWS))
const currentPct = computed(() => Math.min(100, Math.max(0, pct(frameNo.value))))

function onRowClick(e: MouseEvent, row: Row) {
  if (e.ctrlKey || e.metaKey) {
    toggleSelectBox(row.id)
    return
  }
  selectBox(row.id)
  gotoFrameIndex(row.first)
}

function frameFromEvent(e: MouseEvent): number {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0
  return Math.round(range.value[0] + ratio * span.value)
}

/**
 * 拖拽结束后浏览器还会补一个 click（down 在把手、up 在条形上）。
 * 不吞掉它的话，用户拖完生命周期会顺带跳到松手位置那一帧 —— 拖拽不该改变当前帧。
 */
let suppressClickUntil = 0

function onBarClick(e: MouseEvent, row: Row) {
  if (performance.now() < suppressClickUntil) return
  const frame = frameFromEvent(e)
  if (e.ctrlKey || e.metaKey) toggleSelectBox(row.id)
  else selectBox(row.id)
  gotoFrameIndex(frame)
}

function onBarDblClick(e: MouseEvent, row: Row) {
  addKeyframeAt(row.id, frameFromEvent(e))
}

function onAddKeyframe() {
  if (selectedId.value) addKeyframeAt(selectedId.value, frameNo.value)
}

function onSplit() {
  splitSelectedAt(frameNo.value)
}

function trackCount(): number {
  return rows.value.length
}

/* ---------------- 拖两端改生命周期 ---------------- */
/**
 * 拖拽只在本地改预览值，松手才提交一条命令。
 * 若每个 pointermove 都 exec，一次拖拽会灌进几十条历史，Ctrl+Z 就没法用了。
 */
const drag = ref<{ id: string; edge: 'first' | 'last'; first: number; last: number } | null>(null)
let dragRect: DOMRect | null = null
let dragMoved = false

function rowStart(row: Row): number {
  return drag.value?.id === row.id ? drag.value.first : row.first
}
function rowEnd(row: Row): number {
  return drag.value?.id === row.id ? drag.value.last : row.last
}

function startDrag(e: PointerEvent, row: Row, edge: 'first' | 'last') {
  e.preventDefault()
  e.stopPropagation()
  const bar = (e.currentTarget as HTMLElement).closest('.tl-bar') as HTMLElement | null
  if (!bar) return
  dragRect = bar.getBoundingClientRect()
  selectBox(row.id)
  drag.value = { id: row.id, edge, first: row.first, last: row.last }
  dragMoved = false
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', endDrag, { once: true })
}

function frameAtX(clientX: number): number {
  if (!dragRect || !dragRect.width) return range.value[0]
  const ratio = (clientX - dragRect.left) / dragRect.width
  const f = Math.round(range.value[0] + ratio * span.value)
  return Math.min(range.value[1], Math.max(range.value[0], f))
}

function onDragMove(ev: PointerEvent) {
  const d = drag.value
  if (!d) return
  const f = frameAtX(ev.clientX)
  const next = d.edge === 'first' ? Math.min(f, d.last) : Math.max(f, d.first)
  if (next !== (d.edge === 'first' ? d.first : d.last)) dragMoved = true
  if (d.edge === 'first') d.first = next
  else d.last = next
}

function endDrag() {
  window.removeEventListener('pointermove', onDragMove)
  dragRect = null
  const d = drag.value
  drag.value = null
  if (!d) return
  if (dragMoved) suppressClickUntil = performance.now() + 80
  setTrackLifecycle(d.id, d.first, d.last)
}

onBeforeUnmount(() => window.removeEventListener('pointermove', onDragMove))

/* ---------------- 右键菜单 ---------------- */
const menu = ref<{ x: number; y: number; row: Row; frame: number } | null>(null)

function onBarContextMenu(e: MouseEvent, row: Row) {
  e.preventDefault()
  selectBox(row.id)
  menu.value = { x: e.clientX, y: e.clientY, row, frame: frameFromEvent(e) }
}

function closeMenu() {
  menu.value = null
}

function runMenu(fn: () => void) {
  fn()
  closeMenu()
}

/** 从右键位置裁剪：起点设为该帧 / 终点设为该帧 */
function trimTo(frame: number, edge: 'first' | 'last') {
  const row = menu.value?.row
  if (!row) return
  if (edge === 'first') setTrackLifecycle(row.id, frame, row.last)
  else setTrackLifecycle(row.id, row.first, frame)
}
</script>

<template>
  <section v-if="frames.length" class="timeline" :class="{ closed: !open }">
    <header class="tl-head">
      <button class="tl-toggle" :title="open ? '收起时间线' : '展开时间线'" @click="open = !open">
        {{ open ? '▾' : '▸' }}
      </button>
      <span class="tl-title">轨迹时间线</span>
      <span class="tl-meta">{{ trackCount() }} 条 · 帧 {{ frameNo }}</span>
      <span class="tl-spacer" />
      <template v-if="open">
        <button class="tl-btn" :disabled="!selectedId" title="在指针所在帧补一个关键帧" @click="onAddKeyframe">
          + 关键帧
        </button>
        <button class="tl-btn" :disabled="!selectedId" title="把选中轨迹在指针所在帧拆成两条" @click="onSplit">
          拆分
        </button>
        <button class="tl-btn" :disabled="selectedIds.size < 2" title="Ctrl 多选后合并（第一条保留 id）" @click="mergeSelectedTracks">
          合并{{ selectedIds.size > 1 ? ` ${selectedIds.size}` : '' }}
        </button>
        <button class="tl-btn" title="按运动模型补全所有轨迹的中间帧（可撤销）" @click="doInterpolate">
          插值补全
        </button>
      </template>
    </header>

    <div v-if="open" class="tl-body">
      <div class="tl-grid">
        <div
          v-for="row in visibleRows"
          :key="row.id"
          class="tl-row"
          :class="{ on: row.selected }"
        >
          <button class="tl-name" :title="`${row.label} #${row.id} · ${row.keyframes.length} 个关键帧`" @click="onRowClick($event, row)">
            <span class="tl-dot" />
            <span class="tl-label">{{ row.label }}</span>
            <span class="tl-id">#{{ row.id }}</span>
          </button>
          <div
            class="tl-bar"
            :title="`${row.label} #${row.id}：第 ${row.first}→${row.last} 帧，${row.keyframes.length} 个关键帧（拖两端改生命周期）`"
            @click="onBarClick($event, row)"
            @dblclick.prevent="onBarDblClick($event, row)"
            @contextmenu="onBarContextMenu($event, row)"
          >
            <span
              class="tl-span"
              :style="{
                left: pct(rowStart(row)) + '%',
                width: Math.max(0.6, pct(rowEnd(row)) - pct(rowStart(row))) + '%',
              }"
            />
            <span
              class="tl-handle"
              :style="{ left: pct(rowStart(row)) + '%' }"
              title="拖动改起始帧"
              @pointerdown="startDrag($event, row, 'first')"
              @click.stop
            />
            <span
              class="tl-handle"
              :style="{ left: pct(rowEnd(row)) + '%' }"
              title="拖动改结束帧"
              @pointerdown="startDrag($event, row, 'last')"
              @click.stop
            />
            <i
              v-for="t in row.ticks"
              :key="t"
              class="tl-kf"
              :style="{ left: t + '%' }"
            />
            <span v-if="row.selected" class="tl-now" :style="{ left: currentPct + '%' }" />
          </div>
        </div>
      </div>
      <div v-if="hiddenCount" class="tl-more">还有 {{ hiddenCount }} 条轨迹未显示（按类别过滤或缩小范围后可见）</div>
    </div>

    <template v-if="menu">
      <div class="tl-menu-mask" @click="closeMenu" @contextmenu.prevent="closeMenu" />
      <div class="tl-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <div class="tl-menu-title">{{ menu.row.label }} #{{ menu.row.id }}</div>
        <button @click="runMenu(() => addKeyframeAt(menu!.row.id, menu!.frame))">在第 {{ menu.frame }} 帧补关键帧</button>
        <button @click="runMenu(() => splitSelectedAt(menu!.frame))">在第 {{ menu.frame }} 帧拆分</button>
        <div class="tl-menu-sep" />
        <button @click="runMenu(() => trimTo(menu!.frame, 'first'))">起点设为第 {{ menu.frame }} 帧</button>
        <button @click="runMenu(() => trimTo(menu!.frame, 'last'))">终点设为第 {{ menu.frame }} 帧</button>
        <div class="tl-menu-sep" />
        <button @click="runMenu(() => toggleLocked(menu!.row.id))">{{ isLocked(menu.row.id) ? '解锁' : '锁定' }}轨迹</button>
        <button @click="runMenu(() => toggleHidden(menu!.row.id))">隐藏/显示轨迹</button>
        <button class="danger" @click="runMenu(() => { selectBox(menu!.row.id); deleteSelected() })">删除轨迹</button>
      </div>
    </template>

    <div v-if="open" class="tl-axis">
      <span>{{ range[0] }}</span>
      <span class="tl-axis-hint">★ 实心刻度 = 关键帧 · 双点击条形补关键帧</span>
      <span>{{ range[1] }}</span>
    </div>
  </section>
</template>

<style scoped>
.timeline {
  flex: 0 0 auto;
  border-top: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  flex-direction: column;
}
.timeline.closed { background: var(--panel-2); }

.tl-head {
  height: 30px; flex: 0 0 30px;
  display: flex; align-items: center; gap: 8px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
}
.timeline.closed .tl-head { border-bottom: none; }
.tl-toggle {
  width: 18px; height: 18px; padding: 0; line-height: 1;
  background: transparent; color: var(--muted); border: none; font-size: 11px;
}
.tl-toggle:hover { color: var(--text); }
.tl-title { font-size: 11px; font-weight: 600; letter-spacing: .2px; }
.tl-meta { font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
.tl-spacer { flex: 1; }
.tl-btn {
  height: 20px; padding: 0 7px; font-size: 10px;
  background: var(--panel-2); color: var(--text);
  border: 1px solid var(--border); border-radius: 4px;
}
.tl-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.tl-btn:disabled { opacity: .4; cursor: not-allowed; }

.tl-body { max-height: 132px; overflow-y: auto; padding: 4px 0; }
.tl-grid { display: flex; flex-direction: column; gap: 1px; }

.tl-row { display: flex; align-items: center; height: 18px; }
.tl-row.on { background: rgba(79, 195, 247, .08); }

.tl-name {
  flex: 0 0 138px; width: 138px;
  display: flex; align-items: center; gap: 4px;
  padding: 0 6px; background: transparent; border: none;
  color: var(--muted); font-size: 10px; text-align: left;
  overflow: hidden; white-space: nowrap;
}
.tl-name:hover { color: var(--text); }
.tl-row.on .tl-name { color: var(--accent); }
.tl-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: 0 0 5px; }
.tl-label { overflow: hidden; text-overflow: ellipsis; }
.tl-id { color: var(--muted); font-variant-numeric: tabular-nums; }

.tl-bar {
  position: relative; flex: 1; height: 12px; margin-right: 8px;
  background: rgba(255, 255, 255, .04);
  border-radius: 2px; cursor: crosshair;
}
.tl-bar:hover { background: rgba(255, 255, 255, .07); }

.tl-span {
  position: absolute; top: 3px; height: 6px;
  background: rgba(79, 195, 247, .22);
  border: 1px solid rgba(79, 195, 247, .45);
  border-radius: 2px;
}
.tl-row.on .tl-span { background: rgba(79, 195, 247, .35); border-color: var(--accent); }

.tl-handle {
  position: absolute; top: -1px; width: 5px; height: 14px;
  /* 关键帧刻度是后画的，正好盖住两端的把手（末帧刻度就在 100% 处）。
     给把手更高层级，否则"最后一帧那根刻度"会把拖拽点击吃掉 */
  z-index: 2;
  margin-left: -2px;
  background: rgba(79, 195, 247, .55);
  border-radius: 2px;
  cursor: ew-resize;
  touch-action: none;
}
.tl-handle:hover { background: var(--accent); }
.tl-row.on .tl-handle { background: var(--accent); }

.tl-kf {
  position: absolute; top: 1px; z-index: 1; width: 1px; height: 10px;
  background: rgba(79, 195, 247, .9);
}
.tl-row.on .tl-handle {
  position: absolute; top: -1px; width: 5px; height: 14px;
  /* 关键帧刻度是后画的，正好盖住两端的把手（末帧刻度就在 100% 处）。
     给把手更高层级，否则"最后一帧那根刻度"会把拖拽点击吃掉 */
  z-index: 2;
  margin-left: -2px;
  background: rgba(79, 195, 247, .55);
  border-radius: 2px;
  cursor: ew-resize;
  touch-action: none;
}
.tl-handle:hover { background: var(--accent); }
.tl-row.on .tl-handle { background: var(--accent); }

.tl-kf { background: var(--accent); }

.tl-now {
  position: absolute; top: -2px; width: 1px; height: 16px;
  background: #ffca28;
  box-shadow: 0 0 4px rgba(255, 202, 40, .6);
}

.tl-more { padding: 2px 8px; font-size: 10px; color: var(--muted); }

.tl-axis {
  height: 18px; flex: 0 0 18px;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 8px; font-size: 9px; color: var(--muted);
  border-top: 1px solid var(--border); font-variant-numeric: tabular-nums;
}
.tl-axis-hint { opacity: .7; }

.tl-menu-mask { position: fixed; inset: 0; z-index: 40; }
.tl-menu {
  position: fixed; z-index: 41; min-width: 176px;
  padding: 4px; display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, .45);
}
.tl-menu-title {
  padding: 4px 8px; font-size: 10px; color: var(--muted);
  border-bottom: 1px solid var(--border); margin-bottom: 4px;
}
.tl-menu button {
  padding: 5px 8px; text-align: left; font-size: 11px;
  background: transparent; color: var(--text); border: none; border-radius: 4px;
}
.tl-menu button:hover { background: var(--panel-2); color: var(--accent); }
.tl-menu button.danger:hover { color: #ef5350; }
.tl-menu-sep { height: 1px; background: var(--border); margin: 4px 2px; }
</style>
