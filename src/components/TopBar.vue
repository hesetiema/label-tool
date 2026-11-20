<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../state/studioContext'

const studio = inject(StudioKey)!
const {
  fileInput, labelInput, canUndo, canRedo, undoLabel, doUndo, doRedo, loadRealData,
  loadWorld, loadLocal, onPcdFile, onLabelFile, doExport,
} = studio
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="logo">◈</span>
      <div>
        <div class="title">Point Cloud Label Studio</div>
        <div class="subtitle">点云标注学习工具 · Vue3 + Three.js</div>
      </div>
    </div>
    <div class="top-actions">
      <button :disabled="!canUndo" :title="canUndo ? `撤销：${undoLabel}` : '无可撤销操作'" @click="doUndo">↶ 撤销</button>
      <button :disabled="!canRedo" title="重做" @click="doRedo">↷ 重做</button>
      <button class="real" @click="loadRealData">◉ 真实数据</button>
      <button class="real" @click="loadLocal">◉ nuScenes</button>
      <button class="real" @click="loadWorld">◉ 4D-BEV</button>
      <button @click="fileInput?.click()">导入 PCD</button>
      <button @click="labelInput?.click()">导入标注</button>
      <button class="primary" @click="doExport">导出 JSON ↓</button>
      <input ref="fileInput" type="file" accept=".pcd" hidden @change="onPcdFile" />
      <input ref="labelInput" type="file" accept=".json" hidden @change="onLabelFile" />
    </div>
  </header>
</template>
