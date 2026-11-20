<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const {
  boxes, selectedId, selectBox,
} = studio
</script>

<template>
  <section>
    <h3>对象列表 <span class="count">{{ boxes.length }}</span></h3>
    <div class="obj-list">
      <div
        v-for="b in boxes"
        :key="b.id"
        class="obj"
        :class="{ active: selectedId === b.id }"
        @click="selectBox(b.id)"
      >
        <span class="obj-name">{{ b.label }} #{{ b.id }}</span>
        <span class="obj-meta">x{{ b.position.x.toFixed(0) }} y{{ b.position.y.toFixed(0) }}</span>
      </div>
      <div v-if="!boxes.length" class="empty">暂无标注</div>
    </div>
  </section>
</template>
