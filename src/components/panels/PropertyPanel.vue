<script setup lang="ts">
/**
 * 选中对象的属性面板（CVAT 的 Details）
 * 数值精确输入 + 可见性 + 跨帧传播。所有修改都走 setBoxProp → mutate，可撤销。
 */
import { inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const {
  frames, propagateScope, propagateStrategy, selectedBox, categories, lockedIds,
  onScopeChange, onStrategyChange, doPropagate, toggleSelectedVisibility,
  numVal, strVal, setBoxProp, duplicateSelected, deleteSelected,
} = studio

function locked() {
  return !!selectedBox.value && lockedIds.value.has(selectedBox.value.id)
}
</script>

<template>
  <section v-if="selectedBox" class="panel-sec props">
    <div class="panel-head">
      <span class="panel-title">详情 <b>#{{ selectedBox.id }}</b></span>
      <span v-if="locked()" class="panel-warn">已锁定</span>
    </div>

    <label class="field">类别
      <select :disabled="locked()" :value="selectedBox.label" @change="setBoxProp('label', strVal($event))">
        <option v-for="c in categories" :key="c.name" :value="c.name">{{ c.name }}</option>
      </select>
    </label>

    <div class="field-grid">
      <label>x<input type="number" step="0.1" :disabled="locked()" :value="selectedBox.position.x.toFixed(2)" @input="setBoxProp('x', numVal($event))" /></label>
      <label>y<input type="number" step="0.1" :disabled="locked()" :value="selectedBox.position.y.toFixed(2)" @input="setBoxProp('y', numVal($event))" /></label>
      <label>z<input type="number" step="0.1" :disabled="locked()" :value="selectedBox.position.z.toFixed(2)" @input="setBoxProp('z', numVal($event))" /></label>
      <label>长<input type="number" step="0.1" :disabled="locked()" :value="selectedBox.scale.x.toFixed(2)" @input="setBoxProp('length', numVal($event))" /></label>
      <label>宽<input type="number" step="0.1" :disabled="locked()" :value="selectedBox.scale.y.toFixed(2)" @input="setBoxProp('width', numVal($event))" /></label>
      <label>高<input type="number" step="0.1" :disabled="locked()" :value="selectedBox.scale.z.toFixed(2)" @input="setBoxProp('height', numVal($event))" /></label>
    </div>

    <label class="field">朝向 <span class="mono">{{ (selectedBox.yaw * 180 / Math.PI).toFixed(1) }}°</span>
      <input
        type="range" min="-3.1416" max="3.1416" step="0.005"
        :disabled="locked()"
        :value="selectedBox.yaw"
        @input="setBoxProp('yaw', numVal($event))"
      />
    </label>

    <div class="btn-row">
      <button class="mini-btn" :disabled="locked()" @click="toggleSelectedVisibility">
        {{ selectedBox.visibility === 'occluded' ? '恢复可见' : '标记遮挡' }}
      </button>
      <button class="mini-btn" @click="duplicateSelected">复制一份</button>
      <button class="mini-btn danger" :disabled="locked()" @click="deleteSelected">删除</button>
    </div>

    <div v-if="frames.length" class="sub-box">
      <div class="sub-title">跨帧传播（目标 #{{ selectedBox.id }}）</div>
      <div class="btn-row">
        <select :value="propagateScope" class="mini-select" @change="onScopeChange">
          <option value="forward">后续帧</option>
          <option value="backward">前序帧</option>
          <option value="all">全部帧</option>
        </select>
        <select :value="propagateStrategy" class="mini-select" @change="onStrategyChange">
          <option value="offset">增量平移</option>
          <option value="replace">整框替换</option>
        </select>
      </div>
      <button class="mini-btn wide" @click="doPropagate">应用到其他帧</button>
    </div>
  </section>
</template>
