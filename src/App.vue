<script setup lang="ts">
/**
 * ============================================================
 * 主界面骨架（对齐 CVAT 3D）
 * ============================================================
 * 布局：顶部工具栏 / 左侧图标条 / 中间画布 + 三联正交 / 右侧对象面板。
 * 业务状态与操作在 state/useStudio，各面板在 components/。
 */
import { provide } from 'vue'
import { useStudio } from './state/useStudio'
import { StudioKey } from './state/studioContext'
import TopBar from './components/TopBar.vue'
import ToolRail from './components/ToolRail.vue'
import Stage from './components/Stage.vue'
import RightPanel from './components/RightPanel.vue'
import StatusBar from './components/StatusBar.vue'
import HelpModal from './components/HelpModal.vue'

const studio = useStudio()
provide(StudioKey, studio)
</script>

<template>
  <div class="app">
    <TopBar />
    <div class="body">
      <ToolRail />
      <Stage />
      <RightPanel />
    </div>
    <StatusBar />
    <HelpModal />
  </div>
</template>
