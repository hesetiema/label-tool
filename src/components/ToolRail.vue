<script setup lang="ts">
/**
 * 左侧图标工具条（对齐 CVAT）
 * 只放画布相关工具：选择 / 平移 / 画框 / 缩放 / 适应 / 复位 / 正交条开关。
 * 图标用 Unicode 几何符号，避免为了几个 icon 引入图标库。
 */
import { inject } from 'vue'
import { StudioKey } from '../state/studioContext'

const studio = inject(StudioKey)!
const {
  tool, cloud, showOrtho, orthoMax, showHelp, getViewer,
  selectBox,
} = studio

function zoom(factor: number) {
  getViewer()?.zoom(factor)
}

function fit() {
  const viewer = getViewer()
  if (!viewer) return
  if (cloud.value) viewer.focusOnCloud(cloud.value)
  else viewer.resetView()
}

function reset3d() {
  getViewer()?.resetView()
}
</script>

<template>
  <nav class="toolrail">
    <button
      class="rail-btn"
      :class="{ on: tool === 'select' }"
      title="选择 / 编辑 (V)"
      @click="tool = 'select'; selectBox(null)"
    >➤</button>
    <button
      class="rail-btn"
      :class="{ on: tool === 'pan' }"
      title="平移视图 (H)：也可中键 / 右键拖拽正交视图"
      @click="tool = 'pan'"
    >✥</button>
    <button
      class="rail-btn"
      :class="{ on: tool === 'draw' }"
      title="画 3D 框 (N)：在 Top 视图拖拽"
      @click="tool = 'draw'; orthoMax = 'top'"
    >▭</button>

    <div class="rail-sep"></div>

    <button class="rail-btn" title="放大" @click="zoom(0.8)">＋</button>
    <button class="rail-btn" title="缩小" @click="zoom(1.25)">－</button>
    <button class="rail-btn" title="适应数据" @click="fit">⤢</button>
    <button class="rail-btn" title="复位 3D 视角" @click="reset3d">⟲</button>

    <div class="rail-sep"></div>

    <button
      class="rail-btn"
      :class="{ on: showOrtho }"
      title="显示 / 隐藏三联正交视图"
      @click="showOrtho = !showOrtho; orthoMax = null"
    >▤</button>

    <div class="rail-spacer"></div>

    <button class="rail-btn" title="快捷键 (F1)" @click="showHelp = true">?</button>
  </nav>
</template>
