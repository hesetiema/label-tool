<script setup lang="ts">
/** 数据集入口（收在「更多」里，避免顶栏堆一排按钮） */
import { inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const {
  loadSequence,
  loadDemo,
  loadRealData,
  loadSemanticDemo,
  fileInput,
  labelInput,
  semanticInput,
  onSemanticFile,
  frames,
  datasetName,
} = studio
</script>

<template>
  <div class="panel-sec">
    <div class="panel-head">
      <span class="panel-title">当前数据集</span>
    </div>
    <div class="hint-small" style="margin-bottom: 8px">
      {{ datasetName }} · {{ frames.length ? frames.length + ' 帧' : '单帧' }}
    </div>
    <button class="mini-btn wide" @click="loadDemo">演示场景</button>
    <button class="mini-btn wide" @click="loadSequence()">5 帧时序演示</button>
    <button class="mini-btn wide" @click="loadRealData">真实数据 + 相机</button>
    <button class="mini-btn wide" @click="loadSemanticDemo">语义分割演示（带逐点标签）</button>
    <button class="mini-btn wide" @click="fileInput?.click()">导入本地 PCD（可多选）</button>
    <button class="mini-btn wide" @click="labelInput?.click()">导入标注（自动识别格式）</button>
    <button class="mini-btn wide" @click="semanticInput?.click()">导入语义标签 .label（SemanticKITTI）</button>
    <input ref="semanticInput" type="file" accept=".label" hidden @change="onSemanticFile" />
    <div class="hint-small">
      多选 PCD 按文件名排序组成时序；同名标注会自动匹配。标注支持 SUSTechPOINTS / KITTI / DAIR-V2X / nuScenes /
      Waymo，导入时自动识别。
    </div>
  </div>
</template>
