<script setup lang="ts">
/**
 * 对象列表 —— 对齐 CVAT 的 Objects 面板
 * 每条对象一张卡片：类别色条 + 类别 + id + 尺寸摘要 + 锁定 / 隐藏 / 删除。
 * 排序与批量锁定是高频操作，放在表头。
 */
import { computed, inject, ref } from 'vue'
import { StudioKey } from '../../state/studioContext'
import type { Box3D } from '../../core/types'

const studio = inject(StudioKey)!
const {
  boxes, selectedId, selectedIds, selectedCount, lockedIds, hiddenIds,
  selectBox, toggleSelectBox, toggleLocked, toggleHidden,
  toggleAllLocked, deleteSelected, colorOf,
} = studio

const sortBy = ref<'id' | 'label'>('id')

const sorted = computed(() => {
  const list = [...boxes.value]
  if (sortBy.value === 'label') {
    list.sort((a, b) => a.label.localeCompare(b.label) || Number(a.id) - Number(b.id))
  } else {
    list.sort((a, b) => Number(a.id) - Number(b.id))
  }
  return list
})

function css(box: Box3D) {
  return '#' + colorOf(box).toString(16).padStart(6, '0')
}

/** Ctrl / Cmd / Shift 点选 = 在集合里增删；普通点击 = 单选 */
function pick(id: string, e: MouseEvent) {
  if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelectBox(id)
  else selectBox(id)
}

function remove(id: string) {
  selectBox(id)
  deleteSelected()
}

function sizeText(b: { scale: { x: number; y: number; z: number } }) {
  return `${b.scale.x.toFixed(1)} × ${b.scale.y.toFixed(1)} × ${b.scale.z.toFixed(1)} m`
}

function posText(b: { position: { x: number; y: number; z: number } }) {
  return `x ${b.position.x.toFixed(1)}  y ${b.position.y.toFixed(1)}`
}
</script>

<template>
  <section class="panel-sec objects">
    <div class="panel-head">
      <span class="panel-title">
        对象 <b>{{ boxes.length }}</b>
        <em v-if="selectedCount > 1" class="panel-count">选中 {{ selectedCount }}</em>
      </span>
      <div class="panel-actions">
        <select v-model="sortBy" class="mini-select" title="排序">
          <option value="id">按 ID</option>
          <option value="label">按类别</option>
        </select>
        <button class="mini-btn" :title="lockedIds.size === boxes.length ? '全部解锁' : '全部锁定'" @click="toggleAllLocked">
          {{ lockedIds.size === boxes.length && boxes.length ? '解锁' : '锁定' }}
        </button>
      </div>
    </div>

    <div class="obj-cards">
      <div
        v-for="b in sorted"
        :key="b.id"
        class="obj-card"
        :class="{
          active: selectedIds.has(b.id),
          primary: selectedId === b.id,
          muted: hiddenIds.has(b.id),
        }"
        @click="pick(b.id, $event)"
      >
        <span class="obj-stripe" :style="{ background: css(b) }"></span>
        <div class="obj-main">
          <div class="obj-line">
            <span class="obj-label">{{ b.label }}</span>
            <span class="obj-id">#{{ b.id }}</span>
            <span v-if="b.visibility === 'occluded'" class="obj-tag">遮挡</span>
            <span v-else-if="b.visibility === 'predicted'" class="obj-tag">预测</span>
          </div>
          <div class="obj-sub">{{ sizeText(b) }} · {{ posText(b) }}</div>
        </div>
        <div class="obj-icons">
          <button
            class="mini-icon"
            :class="{ on: lockedIds.has(b.id) }"
            :title="lockedIds.has(b.id) ? '解锁' : '锁定（防止误改）'"
            @click.stop="toggleLocked(b.id)"
          >{{ lockedIds.has(b.id) ? '▣' : '▢' }}</button>
          <button
            class="mini-icon"
            :class="{ on: hiddenIds.has(b.id) }"
            :title="hiddenIds.has(b.id) ? '显示' : '隐藏'"
            @click.stop="toggleHidden(b.id)"
          >{{ hiddenIds.has(b.id) ? '◌' : '◉' }}</button>
          <button class="mini-icon danger" title="删除" @click.stop="remove(b.id)">✕</button>
        </div>
      </div>
      <div v-if="!boxes.length" class="empty-hint">
        暂无对象。按 <kbd>N</kbd> 切到画框工具，在 Top 视图拖拽即可新建。
      </div>
    </div>
  </section>
</template>
