<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const {
  mode, layout, calib, setLayout, setMode,
} = studio
</script>

<template>
  <section>
    <h3>视图</h3>
    <div class="seg">
      <button :class="{ active: mode === 'bev' }" @click="setMode('bev')">鸟瞰 BEV</button>
      <button :class="{ active: mode === '3d' }" @click="setMode('3d')">3D 透视</button>
    </div>
    <div class="seg" style="margin-top:6px">
      <button :class="{ active: layout === 'cloud' }" @click="setLayout('cloud')">点云</button>
      <button :class="{ active: layout === 'split' }" :disabled="!calib" @click="setLayout('split')">分屏</button>
      <button :class="{ active: layout === 'camera' }" :disabled="!calib" @click="setLayout('camera')">相机</button>
    </div>
    <div v-if="!calib" class="hint-small">加载真实数据后可对照相机图</div>
  </section>
</template>
