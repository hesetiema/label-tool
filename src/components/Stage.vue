<script setup lang="ts">
/**
 * 主舞台：
 *   - 上部：3D 透视视口（最大化正交视图时让位）
 *   - 下部：Top / Side / Front 三联正交视图（CVAT 布局）
 *   - 右侧可选相机分屏（加载真实数据后）
 *
 * 交互约定：所有正交视图共享同一份 boxes 与 selectedId，
 * 任何一处的拖拽都会回写 core，再由 props 同步到其余视图。
 */
import { computed, inject, ref } from 'vue'
import { StudioKey } from '../state/studioContext'
import CameraView from './CameraView.vue'
import Timeline from './Timeline.vue'
import OrthoView from './OrthoView.vue'
import type { OrthoAxis } from '../state/studioCore'
import type { Box3D } from '../core/types'

const studio = inject(StudioKey)!
const {
  viewportRef,
  camViewRef,
  visibleBoxes,
  selectedId,
  selectedIds,
  tool,
  layout,
  calib,
  imageUrl,
  showOrtho,
  orthoMax,
  cloud,
  opacity,
  outlinedBorders,
  showOrientation,
  colorOf,
  colorBy,
  pointColorBy,
  viewerUnavailable,
  selectBox,
  toggleSelectBox,
  selectGroup,
  applyBox,
  applyBoxes,
  createBoxFromRect,
  currentCategory,
  categories,
  lockedIds,
  setCursor,
  hoverId,
  setHover,
  orthoZoom,
  broadcastZoom,
  orthoPan,
  broadcastPan,
  frames,
} = studio

/** 时间线开合由 Stage 持有：HUD 的底距要跟着让位，否则提示条会压住时间线 */
const timelineOpen = ref(true)
const hasTimeline = computed(() => frames.value.length > 0)

const views: { axis: OrthoAxis; title: string }[] = [
  { axis: 'top', title: 'Top · x/y' },
  { axis: 'side', title: 'Side · x/z' },
  { axis: 'front', title: 'Front · y/z' },
]

const split = computed(() => layout.value !== 'cloud' && !!calib.value)
const maxView = computed(() => views.find((v) => v.axis === orthoMax.value))
/** 传给子组件的数组必须稳定引用，否则每次渲染都触发 redraw */
const selectedIdList = computed(() => [...selectedIds.value])
const lockedIdList = computed(() => [...lockedIds.value])

function onCursor(p: { x: number; y: number; z: number } | null) {
  setCursor(p)
}

function onZoom(e: { from: OrthoAxis; scale: number }) {
  broadcastZoom(e.from, e.scale)
}

function onPan(e: { from: OrthoAxis; da: number; db: number }) {
  broadcastPan(e.from, e.da, e.db)
}

function onEdit(box: Box3D) {
  applyBox(box.id, box, 'drag:' + box.id)
}

function onEditMany(list: Box3D[]) {
  applyBoxes(list, 'drag:' + (selectedId.value ?? 'group'))
}

function toggleMax(axis: OrthoAxis) {
  orthoMax.value = orthoMax.value === axis ? null : axis
}

function toggleMaxCurrent() {
  if (orthoMax.value) toggleMax(orthoMax.value)
}

const hint = computed(() => {
  if (tool.value === 'draw') return '在 Top 视图拖出一个矩形 → 自动生成 3D 框，再到 Side 拖绿点调高度'
  if (tool.value === 'pan') return '拖拽任意视图平移；滚轮以光标为中心缩放'
  return '单击选中 · 空白拖拽框选 · Ctrl 点选追加 · 拖角点缩放 · 拖黄点旋转 · Side/Front 拖绿点调高度 · 双击最大化'
})
</script>

<template>
  <main
    class="stage"
    :class="{ 'timeline-open': hasTimeline && timelineOpen, 'timeline-closed': hasTimeline && !timelineOpen }"
  >
    <div class="stage-main" :class="{ split, 'ortho-maxed': !!orthoMax }">
      <div v-show="!orthoMax" ref="viewportRef" class="viewport"></div>
      <!-- WebGL 初始化失败时画布永远是黑的：把原因写在这儿，而不是留一块黑框 -->
      <div v-if="viewerUnavailable && !orthoMax" class="viewport-fallback">{{ viewerUnavailable }}</div>

      <OrthoView
        v-if="maxView"
        class="ortho-full"
        :axis="maxView.axis"
        :title="maxView.title"
        :cloud="cloud"
        :boxes="visibleBoxes"
        :selected-id="selectedId"
        :selected-ids="selectedIdList"
        :locked-ids="lockedIdList"
        :hover-id="hoverId"
        :zoom-signal="orthoZoom"
        :pan-signal="orthoPan"
        :tool="tool"
        :color-of="colorOf"
        :point-color-by="pointColorBy"
        :opacity="opacity"
        :outlined-borders="outlinedBorders"
        :show-orientation="showOrientation"
        @select="selectBox"
        @toggle="toggleSelectBox"
        @band="selectGroup"
        @edit="onEdit"
        @edit-many="onEditMany"
        @create="createBoxFromRect"
        @cursor="onCursor"
        @hover="setHover"
        @zoom="onZoom"
        @pan="onPan"
        @maximize="toggleMaxCurrent"
      />

      <div v-if="split && !orthoMax" class="camera-pane">
        <CameraView
          ref="camViewRef"
          :boxes="visibleBoxes"
          :calib="calib"
          :image-url="imageUrl"
          :selected-id="selectedId"
          :hover-id="hoverId"
          :color-of="colorOf"
          :color-key="colorBy"
          @hover="setHover"
        />
      </div>
    </div>

    <div v-show="showOrtho && !orthoMax" class="ortho-strip">
      <OrthoView
        v-for="v in views"
        :key="v.axis"
        compact
        :axis="v.axis"
        :title="v.title"
        :cloud="cloud"
        :boxes="visibleBoxes"
        :selected-id="selectedId"
        :selected-ids="selectedIdList"
        :locked-ids="lockedIdList"
        :hover-id="hoverId"
        :zoom-signal="orthoZoom"
        :pan-signal="orthoPan"
        :tool="tool"
        :color-of="colorOf"
        :point-color-by="pointColorBy"
        :opacity="opacity"
        :outlined-borders="outlinedBorders"
        :show-orientation="showOrientation"
        @select="selectBox"
        @toggle="toggleSelectBox"
        @band="selectGroup"
        @edit="onEdit"
        @edit-many="onEditMany"
        @create="createBoxFromRect"
        @cursor="onCursor"
        @hover="setHover"
        @zoom="onZoom"
        @pan="onPan"
        @maximize="toggleMax(v.axis)"
      />
    </div>

    <Timeline v-model:open="timelineOpen" />

    <div v-if="orthoMax" class="view-switch">
      <button v-for="v in views" :key="v.axis" :class="{ on: orthoMax === v.axis }" @click="orthoMax = v.axis">
        {{ v.title.split(' ')[0] }}
      </button>
      <button class="restore" @click="orthoMax = null">还原三联</button>
    </div>

    <div class="stage-hud">
      <span class="hud-tool">{{ tool === 'select' ? '选择' : tool === 'pan' ? '平移' : '画框' }}</span>
      <select
        v-if="tool === 'draw'"
        v-model="currentCategory"
        class="hud-select"
        title="新框类别（数字键 1-9 快速切换）"
      >
        <option v-for="c in categories" :key="c.name" :value="c.name">{{ c.name }}</option>
      </select>
      <span class="hud-hint">{{ hint }}</span>
      <span v-if="!showOrtho" class="hud-warn">正交视图已隐藏（左侧 ▤ 可恢复）</span>
    </div>
  </main>
</template>
