<script setup lang="ts">
/** 数据集入口（收在「更多」里，避免顶栏堆一排按钮） */
import { inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const {
  loadSequence, loadDemo, loadRealData, fileInput, labelInput, frames, datasetName,
} = studio
</script>

<template>
  <div class="panel-sec">
    <div class="panel-head">
      <span class="panel-title">当前数据集</span>
    </div>
    <div class="hint-small" style="margin-bottom:8px">{{ datasetName }} · {{ frames.length ? frames.length + ' 帧' : '单帧' }}</div>
    <button class="mini-btn wide" @click="loadDemo">演示场景</button>
    <button class="mini-btn wide" @click="loadSequence">5 帧时序演示</button>
    <button class="mini-btn wide" @click="loadRealData">真实数据 + 相机</button>
    <button class="mini-btn wide" @click="fileInput?.click()">导入本地 PCD（可多选）</button>
    <button class="mini-btn wide" @click="labelInput?.click()">导入标注 JSON</button>
    <div class="hint-small">
      多选 PCD 时按文件名自然排序组成时序；同名 JSON 会自动匹配到对应帧。
    </div>
  </div>
</template>
