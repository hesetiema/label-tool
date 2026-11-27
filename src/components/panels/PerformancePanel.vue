<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const { perfBusy, perfStats, runPerfTest } = studio
</script>

<template>
  <section>
    <h3>性能实验室</h3>
    <button class="ghost wide" :disabled="perfBusy" @click="runPerfTest">
      {{ perfBusy ? '压测中…' : '⚡ 生成 100 万点压测' }}
    </button>
    <div v-if="perfStats" class="perf-stats mono">{{ perfStats }}</div>
    <div class="hint-small">体素下采样 + 距离 LOD，实测优化后的渲染帧率</div>
  </section>
</template>
