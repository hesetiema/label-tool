<script setup lang="ts">
/**
 * ============================================================
 * 主界面骨架
 * ============================================================
 * 职责：创建唯一的 studio 实例并向下提供，组织顶栏 / 侧栏 / 主视口 / 状态栏。
 * 业务状态与操作在 state/useStudio，各功能面板在 components/ 与 components/panels/。
 */
import { provide, ref } from 'vue'
import { useStudio } from './state/useStudio'
import { StudioKey } from './state/studioContext'
import TopBar from './components/TopBar.vue'
import Stage from './components/Stage.vue'
import HelpPanel from './components/HelpPanel.vue'
import StatusBar from './components/StatusBar.vue'
import ViewPanel from './components/panels/ViewPanel.vue'
import CategoryPanel from './components/panels/CategoryPanel.vue'
import ObjectPanel from './components/panels/ObjectPanel.vue'
import PropertyPanel from './components/panels/PropertyPanel.vue'
import DataPanel from './components/panels/DataPanel.vue'
import SequencePanel from './components/panels/SequencePanel.vue'
import CameraDirectorPanel from './components/panels/CameraDirectorPanel.vue'
import PerformancePanel from './components/panels/PerformancePanel.vue'
import QualityPanel from './components/panels/QualityPanel.vue'

const studio = useStudio()
provide(StudioKey, studio)

type SideTab = 'annotate' | 'sequence' | 'demo'
const tabs: { key: SideTab; label: string }[] = [
  { key: 'annotate', label: '标注' },
  { key: 'sequence', label: '时序' },
  { key: 'demo', label: '演示与质检' },
]

/** 按 URL 预设决定默认 Tab：序列类数据落在「时序」，质检落在「演示与质检」，其余进「标注」 */
function initialTab(): SideTab {
  const p = new URLSearchParams(location.search)
  const data = p.get('data') ?? ''
  if (data === 'qa') return 'demo'
  if (data === 'sequence' || data === 'world' || data === 'nuscenes' || p.get('autoplay') === '1') return 'sequence'
  return 'annotate'
}
const activeTab = ref<SideTab>(initialTab())
</script>

<template>
  <div class="app">
    <TopBar />

    <div class="body">
      <aside class="sidebar">
        <nav class="side-tabs">
          <button
            v-for="t in tabs"
            :key="t.key"
            :class="{ active: activeTab === t.key }"
            @click="activeTab = t.key"
          >{{ t.label }}</button>
        </nav>

        <template v-if="activeTab === 'annotate'">
          <ViewPanel />
          <CategoryPanel />
          <ObjectPanel />
          <PropertyPanel />
          <DataPanel />
        </template>
        <SequencePanel v-else-if="activeTab === 'sequence'" />
        <template v-else>
          <CameraDirectorPanel />
          <PerformancePanel />
          <QualityPanel />
        </template>
      </aside>

      <Stage />
      <HelpPanel />
    </div>

    <StatusBar />
  </div>
</template>
