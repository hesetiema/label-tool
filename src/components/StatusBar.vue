<script setup lang="ts">
import { computed, inject } from 'vue'
import { StudioKey } from '../state/studioContext'
import { boxSizeSummary } from '../viewer/canvasPrimitives'

const studio = inject(StudioKey)!
const {
  cloud, statusText, boxes, frames, currentFrame, selectedId, selectedCount,
  tool, saveState, lockedIds, cursor, hoverId,
} = studio

/** 鼠标指着的对象：3D 视口和正交视图共用同一个悬停状态 */
const hoveredBox = computed(() => (hoverId.value ? boxes.value.find((b) => b.id === hoverId.value) : undefined))
</script>

<template>
  <footer class="statusbar">
    <span class="status-dot" :class="saveState"></span>
    <span class="status-text">{{ statusText }}</span>
    <span class="spacer"></span>
    <span class="status-coord mono" title="光标处的点云坐标（悬停在正交视图上读取）">
      <template v-if="cursor">
        <span>x {{ cursor.x.toFixed(2) }}</span>
        <span>y {{ cursor.y.toFixed(2) }}</span>
        <span>z {{ cursor.z.toFixed(2) }}</span>
      </template>
      <span v-else class="status-coord-idle">x — y — z —</span>
    </span>
    <span v-if="hoveredBox" class="status-chip hover" title="鼠标指向的对象：类别 / 编号 / 长×宽×高 / 朝向">
      悬停 {{ hoveredBox.label }} #{{ hoveredBox.id }} · {{ boxSizeSummary(hoveredBox) }}
    </span>
    <span v-if="selectedCount > 1" class="status-chip on">选中 {{ selectedCount }}</span>
    <span v-else-if="selectedId" class="status-chip">选中 #{{ selectedId }}</span>
    <span v-if="lockedIds.size" class="status-chip">锁定 {{ lockedIds.size }}</span>
    <span v-if="frames.length" class="status-chip">帧 {{ currentFrame + 1 }}/{{ frames.length }}</span>
    <span class="status-chip">{{ tool === 'select' ? '选择' : tool === 'pan' ? '平移' : '画框' }}</span>
    <span class="status-chip">{{ boxes.length }} 框</span>
    <span class="mono">{{ (cloud?.count ?? 0).toLocaleString() }} pts</span>
  </footer>
</template>
