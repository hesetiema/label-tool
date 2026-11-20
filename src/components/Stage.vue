<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../state/studioContext'
import CameraView from './CameraView.vue'

const studio = inject(StudioKey)!
const {
  viewportRef, camViewRef, boxes, selectedId, mode, layout, calib, imageUrl,
} = studio
</script>

<template>
  <main class="stage" :class="'layout-' + layout">
    <div ref="viewportRef" class="viewport" v-show="layout !== 'camera'"></div>
    <div class="hud" v-show="layout !== 'camera'">
      <span class="mode-tag">{{ mode === 'bev' ? '鸟瞰视图 (BEV)' : '3D 透视视图' }}</span>
      <span v-if="mode === 'bev'" class="hint">拖拽画框 · 滚轮缩放</span>
      <span v-else class="hint">左键旋转 · 右键平移 · 滚轮缩放</span>
    </div>
    <div class="camera-pane" v-show="layout !== 'cloud' && calib">
      <CameraView
        ref="camViewRef"
        :boxes="boxes"
        :calib="calib"
        :image-url="imageUrl"
        :selected-id="selectedId"
      />
    </div>
  </main>
</template>
