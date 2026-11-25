<script setup lang="ts">
/**
 * 右侧面板（对齐 CVAT）：对象 / 标签 / 更多
 * 对象页 = 列表 + 选中详情 + 外观；标签页 = 类别配置；
 * 「更多」把时序、质检、运镜、性能这些低频但重要的能力折叠收纳，主流程保持干净。
 */
import { computed, inject, ref } from 'vue'
import { StudioKey } from '../state/studioContext'
import { semanticStats } from '../core/semantics'
import ObjectPanel from './panels/ObjectPanel.vue'
import CategoryPanel from './panels/CategoryPanel.vue'
import PropertyPanel from './panels/PropertyPanel.vue'
import DataPanel from './panels/DataPanel.vue'
import SequencePanel from './panels/SequencePanel.vue'
import QualityPanel from './panels/QualityPanel.vue'
import TaskPanel from './panels/TaskPanel.vue'
import VlaPanel from './panels/VlaPanel.vue'
import CameraDirectorPanel from './panels/CameraDirectorPanel.vue'
import PerformancePanel from './panels/PerformancePanel.vue'

const studio = inject(StudioKey)!
const {
  colorBy, pointColorBy, opacity, outlinedBorders, showOrientation, linkZoom, linkPan, cloud,
} = studio

/** 当前点云是否带逐点语义标签 */
const hasSemantics = computed(() => !!cloud.value?.labels?.length)
const stats = computed(() => (hasSemantics.value ? semanticStats(cloud.value!) : []))
const hex = (color: number) => '#' + color.toString(16).padStart(6, '0')

type Tab = 'objects' | 'labels' | 'tasks' | 'vla' | 'more'
const tab = ref<Tab>('objects')
</script>

<template>
  <aside class="right-panel">
    <nav class="rp-tabs">
      <button :class="{ on: tab === 'objects' }" @click="tab = 'objects'">对象</button>
      <button :class="{ on: tab === 'labels' }" @click="tab = 'labels'">标签</button>
      <button :class="{ on: tab === 'tasks' }" @click="tab = 'tasks'">任务</button>
      <button :class="{ on: tab === 'vla' }" @click="tab = 'vla'">VLA</button>
      <button :class="{ on: tab === 'more' }" @click="tab = 'more'">更多</button>
    </nav>

    <div class="rp-body">
      <template v-if="tab === 'objects'">
        <ObjectPanel />
        <PropertyPanel />

        <section class="panel-sec">
          <div class="panel-head"><span class="panel-title">外观</span></div>
          <div class="appearance-row">
            <span class="appearance-label">框着色</span>
            <div class="seg mini">
              <button :class="{ on: colorBy === 'label' }" @click="colorBy = 'label'">类别</button>
              <button :class="{ on: colorBy === 'instance' }" @click="colorBy = 'instance'">实例</button>
            </div>
          </div>
          <div v-if="hasSemantics" class="appearance-row">
            <span class="appearance-label">点云</span>
            <div class="seg mini">
              <button :class="{ on: pointColorBy === 'default' }" @click="pointColorBy = 'default'">默认</button>
              <button :class="{ on: pointColorBy === 'semantic' }" @click="pointColorBy = 'semantic'">语义</button>
            </div>
          </div>
          <div v-if="hasSemantics && pointColorBy === 'semantic'" class="semantic-legend">
            <div class="semantic-legend-title">语义类别 · {{ stats.length }} 类</div>
            <div v-for="s in stats" :key="s.id" class="semantic-legend-row">
              <span class="semantic-swatch" :style="{ background: hex(s.color) }"></span>
              <span class="semantic-name">{{ s.name }}</span>
              <span class="semantic-count">{{ (s.ratio * 100).toFixed(1) }}%</span>
            </div>
          </div>
          <label class="appearance-row range-row">
            <span class="appearance-label">不透明度</span>
            <input v-model.number="opacity" type="range" min="0.2" max="1" step="0.05" />
          </label>
          <label class="check-row">
            <input v-model="outlinedBorders" type="checkbox" /> 仅描边（不填充面）
          </label>
          <label class="check-row">
            <input v-model="showOrientation" type="checkbox" /> 显示朝向短线
          </label>
          <label class="check-row" title="三张正交视图同步到相同「米/像素」，方便比较各处比例">
            <input v-model="linkZoom" type="checkbox" /> 三视图联动缩放
          </label>
          <label class="check-row" title="三张正交视图同步平移相同的世界距离，始终看着同一块区域">
            <input v-model="linkPan" type="checkbox" /> 三视图联动平移
          </label>
        </section>
      </template>

      <CategoryPanel v-else-if="tab === 'labels'" />
      <TaskPanel v-else-if="tab === 'tasks'" />
      <VlaPanel v-else-if="tab === 'vla'" />

      <div v-else class="more-list">
        <details open>
          <summary>数据集</summary>
          <DataPanel />
        </details>
        <details>
          <summary>时序与 4D</summary>
          <SequencePanel />
        </details>
        <details>
          <summary>质检与一致性</summary>
          <QualityPanel />
        </details>
        <details>
          <summary>相机导演与录制</summary>
          <CameraDirectorPanel />
        </details>
        <details>
          <summary>性能压测</summary>
          <PerformancePanel />
        </details>
      </div>
    </div>
  </aside>
</template>
