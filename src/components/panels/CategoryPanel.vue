<script setup lang="ts">
/**
 * 标签配置 —— 对齐 CVAT 的 Labels 面板
 * 与旧版「写死 5 个类别、只读」的区别：颜色可改、可新增、可删除（未被使用时）。
 * 配置随草稿持久化，导出的标注里也会带上类别名。
 */
import { inject, ref } from 'vue'
import { StudioKey } from '../../state/studioContext'
import type { ObjectCategory } from '../../core/types'

const studio = inject(StudioKey)!
const {
  categories, boxes, currentCategory, statusText, upsertCategory, removeCategory,
} = studio

const newName = ref('')
const palette = [0x4fc3f7, 0xff7043, 0x66bb6a, 0xab47bc, 0xffca28, 0x26c6da, 0xff4081, 0x8bc34a]

function hex(cat: ObjectCategory) {
  return '#' + cat.color.toString(16).padStart(6, '0')
}

function countOf(name: string) {
  return boxes.value.filter((b) => b.label === name).length
}

function setColor(cat: ObjectCategory, e: Event) {
  const v = (e.target as HTMLInputElement).value
  const color = parseInt(v.replace('#', ''), 16)
  if (Number.isFinite(color)) upsertCategory({ ...cat, color })
}

function add() {
  const name = newName.value.trim()
  if (!name) return
  if (categories.value.some((c) => c.name === name)) {
    statusText.value = `类别「${name}」已存在`
    return
  }
  const color = palette[categories.value.length % palette.length]
  upsertCategory({ name, color, defaultSize: [4.5, 1.8, 1.6] })
  currentCategory.value = name
  newName.value = ''
  statusText.value = `已新增类别「${name}」，当前画框会使用它`
}

function remove(cat: ObjectCategory) {
  if (countOf(cat.name) > 0) {
    statusText.value = `「${cat.name}」下还有 ${countOf(cat.name)} 个框，先改类别再删除`
    return
  }
  removeCategory(cat.name)
  if (currentCategory.value === cat.name) {
    currentCategory.value = categories.value[0]?.name ?? 'Car'
  }
  statusText.value = `已删除类别「${cat.name}」`
}
</script>

<template>
  <section class="panel-sec">
    <div class="panel-head">
      <span class="panel-title">标签 <b>{{ categories.length }}</b></span>
      <span class="panel-sub">点一行设为当前类别</span>
    </div>

    <div class="label-list">
      <div
        v-for="c in categories"
        :key="c.name"
        class="label-row"
        :class="{ active: currentCategory === c.name }"
        @click="currentCategory = c.name"
      >
        <input
          type="color"
          class="color-input"
          :value="hex(c)"
          title="修改颜色"
          @click.stop
          @change="setColor(c, $event)"
        />
        <span class="label-name">{{ c.name }}</span>
        <span class="label-count">{{ countOf(c.name) }}</span>
        <button class="mini-icon danger" title="删除类别（需先清空该类的框）" @click.stop="remove(c)">✕</button>
      </div>
    </div>

    <div class="label-add">
      <input v-model="newName" class="text-input" placeholder="新类别名，如 Bus" @keydown.enter="add" />
      <button class="mini-btn" @click="add">添加</button>
    </div>
    <div class="hint-small">新类别默认尺寸 4.5×1.8×1.6 m，画框后可在属性面板精调。</div>
  </section>
</template>
