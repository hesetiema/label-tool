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
import SampleList from './components/SampleList.vue'
import ReviewQueue from './components/ReviewQueue.vue'

const studio = useStudio()
provide(StudioKey, studio)

/**
 * 开发期把手测入口挂到 window：
 *   studio.runBlobGc()              手动清扫本地缓存
 *   studio.runBlobGc({ dryRun: true })  只看计划不删（见 studioGc 的 dryRun）
 *   studio.store.value?.liveBlobRefs()  当前仍被引用的载荷键
 *   studio.gcAudit()                最近的清扫审计（谁/何时/删了多少/多少靠对端保下）
 *   studio.tabBus.peers()           同源其它标签页
 *   studio.readOnly.value           是否因"别处正在写同一样本"而只读
 *   studio.openList()               本地样本列表（浏览 / 删除落盘文档）
 *   studio.runBlobGc({ reclaimBytes: 5e6 })  强制腾出 5MB（配额淘汰的手测入口）
 *   studio.setEvictionPolicy('lfu') 切换淘汰策略（lru / lfu / hybrid，URL 用 ?evict=）
 *   studio.runMock()                跑演示预标注（确定性），合入后自动开复核队列
 *   studio.stats.value              复核统计（待裁决轨迹 / 帧 / 冲突数）
 *   studio.persistedSnapshot()      落盘记账（为什么这次保存没走点云外置）
 * 生产构建不挂 —— 这不是公开 API，只是排障窗口。
 */
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).studio = studio
}
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
    <SampleList />
    <ReviewQueue />
  </div>
</template>
