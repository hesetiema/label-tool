<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const {
  loadSequence, loadDemo,
} = studio
</script>

<template>
  <button class="ghost wide" @click="loadDemo">重置演示场景</button>
  <button class="ghost wide" @click="loadSequence">加载 5 帧序列</button>
</template>
