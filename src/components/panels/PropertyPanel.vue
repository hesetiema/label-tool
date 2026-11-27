<script setup lang="ts">
/**
 * 选中对象的属性面板（CVAT 的 Details）
 * 单选：精确数值输入 + 可见性 + 跨帧传播
 * 多选：只给批量动作（改类别 / 锁定 / 复制 / 删除），逐字段精调没有意义
 * 所有修改都走 setBoxProp / relabelSelected → mutate，可撤销。
 */
import { computed, inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const {
  frames,
  propagateScope,
  propagateStrategy,
  selectedBox,
  selectedBoxes,
  selectedCount,
  categories,
  lockedIds,
  selectBox,
  toggleLocked,
  onScopeChange,
  onStrategyChange,
  doPropagate,
  toggleSelectedVisibility,
  numVal,
  strVal,
  setBoxProp,
  relabelSelected,
  duplicateSelected,
  deleteSelected,
  copyToFrames,
} = studio

function locked() {
  return !!selectedBox.value && lockedIds.value.has(selectedBox.value.id)
}

/** 多选摘要：按类别聚合成 "Car ×3 · Van ×1" */
const summary = computed(() => {
  const tally = new Map<string, number>()
  for (const b of selectedBoxes.value) tally.set(b.label, (tally.get(b.label) ?? 0) + 1)
  return [...tally.entries()].map(([label, n]) => `${label} ×${n}`).join(' · ')
})

const allLocked = computed(
  () => selectedBoxes.value.length > 0 && selectedBoxes.value.every((b) => lockedIds.value.has(b.id)),
)

function onBatchLabel(e: Event) {
  const el = e.target as HTMLSelectElement
  const label = el.value
  el.value = '' // 回到占位项，方便连续改
  if (label) relabelSelected(label)
}

function toggleLockAll() {
  const next = !allLocked.value
  for (const b of selectedBoxes.value) {
    if (lockedIds.value.has(b.id) !== next) toggleLocked(b.id)
  }
}
</script>

<template>
  <section v-if="selectedCount > 1" class="panel-sec props">
    <div class="panel-head">
      <span class="panel-title"
        >已选 <b>{{ selectedCount }}</b> 个对象</span
      >
      <button class="mini-btn" @click="selectBox(null)">取消</button>
    </div>

    <div class="multi-summary">{{ summary }}</div>

    <label class="field"
      >批量改类别
      <select value="" @change="onBatchLabel">
        <option value="" disabled>选择类别…</option>
        <option v-for="c in categories" :key="c.name" :value="c.name">{{ c.name }}</option>
      </select>
    </label>

    <div class="btn-row">
      <button class="mini-btn" @click="toggleLockAll">{{ allLocked ? '全部解锁' : '全部锁定' }}</button>
      <button class="mini-btn" @click="duplicateSelected">复制一份</button>
      <button class="mini-btn danger" @click="deleteSelected">删除</button>
    </div>

    <div class="multi-tip">
      方向键微调 · <kbd>Shift</kbd>+方向键加速 · 数字键直接改类别 · 在 Top 空白处拖拽可重新框选
    </div>

    <div v-if="frames.length" class="sub-box">
      <div class="sub-title">跨帧复制（保持 id，构成轨迹）</div>
      <div class="btn-row">
        <button class="mini-btn" @click="copyToFrames('next')">下一帧</button>
        <button class="mini-btn" @click="copyToFrames('forward')">后续帧</button>
        <button class="mini-btn" @click="copyToFrames('all')">全部帧</button>
      </div>
      <div class="multi-tip">目标帧已有同 id 的框会跳过，不覆盖已手工调整的标注。</div>
    </div>
  </section>

  <section v-else-if="selectedBox" class="panel-sec props">
    <div class="panel-head">
      <span class="panel-title"
        >详情 <b>#{{ selectedBox.id }}</b></span
      >
      <span v-if="locked()" class="panel-warn">已锁定</span>
    </div>

    <label class="field"
      >类别
      <select :disabled="locked()" :value="selectedBox.label" @change="setBoxProp('label', strVal($event))">
        <option v-for="c in categories" :key="c.name" :value="c.name">{{ c.name }}</option>
      </select>
    </label>

    <div class="field-grid">
      <label
        >x<input
          type="number"
          step="0.1"
          :disabled="locked()"
          :value="selectedBox.position.x.toFixed(2)"
          @input="setBoxProp('x', numVal($event))"
      /></label>
      <label
        >y<input
          type="number"
          step="0.1"
          :disabled="locked()"
          :value="selectedBox.position.y.toFixed(2)"
          @input="setBoxProp('y', numVal($event))"
      /></label>
      <label
        >z<input
          type="number"
          step="0.1"
          :disabled="locked()"
          :value="selectedBox.position.z.toFixed(2)"
          @input="setBoxProp('z', numVal($event))"
      /></label>
      <label
        >长<input
          type="number"
          step="0.1"
          :disabled="locked()"
          :value="selectedBox.scale.x.toFixed(2)"
          @input="setBoxProp('length', numVal($event))"
      /></label>
      <label
        >宽<input
          type="number"
          step="0.1"
          :disabled="locked()"
          :value="selectedBox.scale.y.toFixed(2)"
          @input="setBoxProp('width', numVal($event))"
      /></label>
      <label
        >高<input
          type="number"
          step="0.1"
          :disabled="locked()"
          :value="selectedBox.scale.z.toFixed(2)"
          @input="setBoxProp('height', numVal($event))"
      /></label>
    </div>

    <label class="field"
      >朝向 <span class="mono">{{ ((selectedBox.yaw * 180) / Math.PI).toFixed(1) }}°</span>
      <input
        type="range"
        min="-3.1416"
        max="3.1416"
        step="0.005"
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
      <div class="multi-tip">传播只改「其他帧里同 id 的框」，适合修正整体漂移。</div>
    </div>

    <div v-if="frames.length" class="sub-box">
      <div class="sub-title">跨帧复制（同 id 铺出去）</div>
      <div class="btn-row">
        <button class="mini-btn" @click="copyToFrames('next')">下一帧</button>
        <button class="mini-btn" @click="copyToFrames('forward')">后续帧</button>
        <button class="mini-btn" @click="copyToFrames('all')">全部帧</button>
      </div>
      <div class="multi-tip">
        先标好一帧，再用这里往后铺，然后逐帧微调。<kbd>Ctrl</kbd>+<kbd>B</kbd> 等价的后续帧复制。
      </div>
    </div>
  </section>
</template>
