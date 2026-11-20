<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const {
  currentCategory, DEFAULT_CATEGORIES,
} = studio
</script>

<template>
  <section>
    <h3>标注类别</h3>
    <div class="cat-list">
      <button
        v-for="c in DEFAULT_CATEGORIES"
        :key="c.name"
        class="cat"
        :class="{ active: currentCategory === c.name }"
        @click="currentCategory = c.name"
      >
        <span class="dot" :style="{ background: '#' + c.color.toString(16).padStart(6, '0') }"></span>
        {{ c.name }}
      </button>
    </div>
  </section>
</template>
