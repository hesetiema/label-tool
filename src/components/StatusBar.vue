<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../state/studioContext'

const studio = inject(StudioKey)!
const {
  cloud, statusText,
} = studio
</script>

<template>
  <footer class="statusbar">
    <span class="status-dot"></span>{{ statusText }}
    <span class="spacer"></span>
    <span class="mono">{{ cloud?.count.toLocaleString() ?? 0 }} points</span>
  </footer>
</template>
