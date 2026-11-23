<script setup lang="ts">
/**
 * 顶部工具栏（对齐 CVAT）
 * 左侧：文件 / 数据集菜单；中间：撤销重做 + 帧导航；右侧：保存状态 + 相机 + 帮助。
 * 只保留高频动作，其余都收进菜单，避免一排按钮把画布挤小。
 */
import { inject } from 'vue'
import { StudioKey } from '../state/studioContext'

const studio = inject(StudioKey)!
const {
  datasetName, frames, currentFrame, canUndo, canRedo, undoLabel, saveState, lastSavedAt,
  calib, layout, autosaveEnabled, menuOpen, showHelp,
  loadDemo, loadRealData, loadSequence, doUndo, doRedo, doExportFrame, doExportAll,
  prevFrame, nextFrame, setFrame, setLayout, persistNow, clearDraft, numVal, fileInput, labelInput,
} = studio

function pickFiles() {
  menuOpen.value = false
  fileInput.value?.click()
}

function pickLabels() {
  menuOpen.value = false
  labelInput.value?.click()
}

function act(fn: () => void) {
  menuOpen.value = false
  fn()
}

const saveText = () => {
  if (saveState.value === 'saving') return '保存中…'
  if (saveState.value === 'dirty') return '未保存'
  if (saveState.value === 'error') return '保存失败'
  if (saveState.value === 'off') return '自动保存已关'
  if (saveState.value === 'saved' && lastSavedAt.value) {
    const d = new Date(lastSavedAt.value)
    return `已保存 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return '本地草稿'
}
</script>

<template>
  <header class="topbar">
    <div class="tb-left">
      <button class="brand-btn" :class="{ on: menuOpen }" @click.stop="menuOpen = !menuOpen">
        <span class="brand-mark">◈</span>
        <span class="brand-name">Point Cloud</span>
        <span class="caret">▾</span>
      </button>

      <div v-if="menuOpen" class="menu" @click.stop>
        <div class="menu-title">数据集</div>
        <button @click="act(loadDemo)">演示场景</button>
        <button @click="act(loadRealData)">真实数据（含相机）</button>
        <button @click="act(loadSequence)">5 帧时序演示</button>
        <div class="menu-sep"></div>
        <button @click="pickFiles">导入 PCD（可多选组成时序）</button>
        <button @click="pickLabels">导入标注 JSON</button>
        <div class="menu-sep"></div>
        <div class="menu-title">导出</div>
        <button @click="act(doExportFrame)">当前帧 JSON <kbd>Ctrl S</kbd></button>
        <button :disabled="!frames.length" @click="act(doExportAll)">整段序列 JSON <kbd>Ctrl ⇧ S</kbd></button>
        <div class="menu-sep"></div>
        <div class="menu-title">本地草稿</div>
        <label class="menu-check">
          <input v-model="autosaveEnabled" type="checkbox" /> 自动保存
        </label>
        <button @click="act(() => persistNow(true))">立即保存</button>
        <button class="danger" @click="act(clearDraft)">清除本地草稿</button>
      </div>
      <div v-if="menuOpen" class="menu-backdrop" @click="menuOpen = false"></div>

      <span class="dataset-name" :title="datasetName">{{ datasetName }}</span>
    </div>

    <div class="tb-center">
      <div class="tb-group">
        <button class="tb-icon" :disabled="!canUndo" :title="canUndo ? `撤销：${undoLabel}` : '无可撤销'" @click="doUndo">↶</button>
        <button class="tb-icon" :disabled="!canRedo" title="重做" @click="doRedo">↷</button>
      </div>

      <div v-if="frames.length" class="tb-group frame-nav">
        <button class="tb-icon" title="第一帧" @click="setFrame(0)">|◀</button>
        <button class="tb-icon" title="上一帧" @click="prevFrame">◀</button>
        <input
          class="frame-slider"
          type="range"
          min="0"
          :max="frames.length - 1"
          :value="currentFrame"
          @input="setFrame(numVal($event))"
        />
        <button class="tb-icon" title="下一帧" @click="nextFrame">▶</button>
        <button class="tb-icon" title="最后一帧" @click="setFrame(frames.length - 1)">▶|</button>
        <span class="frame-count">{{ currentFrame + 1 }} / {{ frames.length }}</span>
      </div>
      <span v-else class="single-frame">单帧</span>
    </div>

    <div class="tb-right">
      <span class="save-state" :class="saveState" title="自动保存到浏览器 IndexedDB">{{ saveText() }}</span>
      <button
        v-if="calib"
        class="tb-text"
        :class="{ on: layout !== 'cloud' }"
        title="显示相机投影（分屏）"
        @click="setLayout(layout === 'cloud' ? 'split' : 'cloud')"
      >相机</button>
      <button class="tb-icon" title="快捷键与工作流 (F1)" @click="showHelp = true">?</button>
      <input ref="fileInput" type="file" accept=".pcd" multiple hidden @change="studio.importFiles" />
      <input ref="labelInput" type="file" accept=".json" hidden @change="studio.onLabelFile" />
    </div>
  </header>
</template>
