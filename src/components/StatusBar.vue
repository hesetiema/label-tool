<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../state/studioContext'

const studio = inject(StudioKey)!
const {
  cloud, statusText, boxes, frames, currentFrame, selectedId, tool, saveState, lockedIds,
} = studio
</script>

<template>
  <footer class="statusbar">
    <span class="status-dot" :class="saveState"></span>
    <span class="status-text">{{ statusText }}</span>
    <span class="spacer"></span>
    <span v-if="selectedId" class="status-chip">选中 #{{ selectedId }}</span>
    <span v-if="lockedIds.size" class="status-chip">锁定 {{ lockedIds.size }}</span>
    <span v-if="frames.length" class="status-chip">帧 {{ currentFrame + 1 }}/{{ frames.length }}</span>
    <span class="status-chip">{{ tool === 'select' ? '选择' : tool === 'pan' ? '平移' : '画框' }}</span>
    <span class="status-chip">{{ boxes.length }} 框</span>
    <span class="mono">{{ (cloud?.count ?? 0).toLocaleString() }} pts</span>
  </footer>
</template>
