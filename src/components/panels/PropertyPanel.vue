<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const {
  frames, propagateScope, propagateStrategy, selectedBox, DEFAULT_CATEGORIES,
  onScopeChange, onStrategyChange, doPropagate, toggleSelectedVisibility, numVal, strVal,
  setBoxProp,
} = studio
</script>

<template>
  <section v-if="selectedBox" class="props">
    <h3>属性编辑</h3>
    <label>类别
      <select :value="selectedBox.label" @change="setBoxProp('label', strVal($event))">
        <option v-for="c in DEFAULT_CATEGORIES" :key="c.name" :value="c.name">{{ c.name }}</option>
      </select>
    </label>
    <div class="grid3">
      <label>x<input type="number" step="0.1" :value="selectedBox.position.x" @input="setBoxProp('x', numVal($event))" /></label>
      <label>y<input type="number" step="0.1" :value="selectedBox.position.y" @input="setBoxProp('y', numVal($event))" /></label>
      <label>z<input type="number" step="0.1" :value="selectedBox.position.z" @input="setBoxProp('z', numVal($event))" /></label>
      <label>长<input type="number" step="0.1" :value="selectedBox.scale.x" @input="setBoxProp('length', numVal($event))" /></label>
      <label>宽<input type="number" step="0.1" :value="selectedBox.scale.y" @input="setBoxProp('width', numVal($event))" /></label>
      <label>高<input type="number" step="0.1" :value="selectedBox.scale.z" @input="setBoxProp('height', numVal($event))" /></label>
    </div>
    <label>朝向 yaw <span class="mono">{{ selectedBox.yaw.toFixed(2) }} rad</span>
      <input type="range" min="-3.14" max="3.14" step="0.01" :value="selectedBox.yaw" @input="setBoxProp('yaw', numVal($event))" />
    </label>
    <!-- 4D 跨帧编辑：把当前框的修改传播到其他帧的同 id 框（仅在有时序帧时显示） -->
    <div v-if="selectedBox" class="propagate-box" style="margin-top:8px">
      <button class="ghost wide" @click="toggleSelectedVisibility">
        {{ selectedBox.visibility === 'occluded' ? '◉ 恢复可见' : '◐ 标记为遮挡' }}
      </button>
      <div class="hint-small">遮挡框用虚线显示，4D 质检不把它算作漏标/跳变</div>
    </div>
    <div v-if="frames.length" class="propagate-box">
      <div class="propagate-title">跨帧传播（目标 #{{ selectedBox.id }}）</div>
      <div class="replay-row">
        <select :value="propagateScope" @change="onScopeChange">
          <option value="forward">后续帧</option>
          <option value="backward">前序帧</option>
          <option value="all">全部帧</option>
        </select>
        <select :value="propagateStrategy" @change="onStrategyChange">
          <option value="offset">增量平移</option>
          <option value="replace">整框替换</option>
        </select>
      </div>
      <button class="ghost wide" @click="doPropagate">⇢ 应用到其他帧</button>
      <div class="hint-small">增量平移保留各帧位置、只带去本次改动；整框替换用当前框覆盖其他帧</div>
    </div>
  </section>
</template>
