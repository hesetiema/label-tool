<script setup lang="ts">
/**
 * 任务面板：多任务的"入口 + 体检表"
 *
 * 设计取舍：
 *   - 不在这里做逐格编辑器。占据的主体由框派生，人工只做抽检与单格修正，
 *     所以这里给的是"生成 / 切片 / 补删一格 / 校验 / 导出"这五个动作。
 *   - 进度按任务一行，问题数直接挂在行上。用户不需要先点开报告才知道
 *     "占据这帧和框对不上"。
 *   - 所有动作都走状态层的可撤销命令，所以这里不出现"保存"按钮。
 */
import { computed, inject, ref, watch } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const {
  taskRows,
  taskIssues,
  categories,
  occSpec,
  occEntries,
  occCoverage,
  occStatsNow,
  occNote,
  occBusy,
  showOcc,
  toggleOcc,
  sliceLow,
  sliceHigh,
  setSlice,
  generateOccupancy,
  clearOccupancy,
  paintVoxel,
  ego,
  egoRecord,
  showFlow,
  toggleFlow,
  estimateEgo,
  flowNote,
  issues,
  checkBusy,
  lastCheck,
  runCrossCheck,
  gotoIssue,
  exportOccupancy,
  cursor,
  frameNumber,
} = studio

const genScope = (scope: 'frame' | 'all') => {
  void generateOccupancy(scope)
}
const paint = (action: 'add' | 'remove') => {
  void paintVoxel(action, paintClass.value)
}
const check = (scope: 'current' | 'all') => {
  void runCrossCheck(scope)
}

/** 补格用哪个类别：默认取当前选中框的类别，跟着选中走符合直觉 */
const paintClass = ref('')
watch(
  [() => categories.value.length, () => studio.selectedBox.value?.label],
  () => {
    const label = studio.selectedBox.value?.label
    if (label) paintClass.value = label
    else if (!paintClass.value) paintClass.value = categories.value[0]?.name ?? ''
  },
  { immediate: true },
)

const specText = computed(() => {
  const s = occSpec.value
  if (!s) return '未生成'
  return `${s.size.x}×${s.size.y}×${s.size.z} @ ${s.resolution}m · 类别 ${s.classIds.length}`
})
const coverageText = computed(() => {
  const total = occEntries.value.length
  return total ? `${total} 帧 · ${Math.round(occCoverage.value * 100)}%` : '未生成'
})
const occTop = computed(() => (occStatsNow.value?.perClass ?? []).slice(0, 3))
/**
 * 超过 3 类时给一条"其余"汇总。
 * 只显示前 3 而不作说明，会让人把 chip 加起来对不上占据率 —— 看着像统计错误，
 * 实际只是截断。补一行合并项，代价一个 chip，省掉一次怀疑。
 */
const occRest = computed(() => {
  const all = occStatsNow.value?.perClass ?? []
  if (all.length <= 3) return null
  const rest = all.slice(3)
  return { classes: rest.length, count: rest.reduce((n, c) => n + c.count, 0) }
})
const ratioText = computed(() => {
  const s = occStatsNow.value
  return s ? `${(s.ratio * 100).toFixed(2)}% · ${s.occupied.toLocaleString()} 格` : '—'
})
const zMin = computed(() => occSpec.value?.origin.z ?? -1)
const zMax = computed(() => {
  const s = occSpec.value
  return s ? s.origin.z + s.size.z * s.resolution : 6.4
})
const egoText = computed(() => {
  const m = ego.value ?? (egoRecord.value ? { ...egoRecord.value, inliers: 0, samples: 0 } : null)
  if (!m) return ''
  const deg = ((m.dyaw * 180) / Math.PI).toFixed(1)
  const extra = m.samples ? ` · 内点 ${m.inliers}/${m.samples}` : ''
  return `dx ${m.dx.toFixed(2)}m · dy ${m.dy.toFixed(2)}m · dyaw ${deg}°${extra}`
})
const hasOcc = computed(() => occEntries.value.length > 0)
</script>

<template>
  <section class="tk-panel">
    <h3>
      任务 <span class="count">{{ taskRows.length }}</span>
    </h3>
    <ul class="tk-task-list">
      <li v-for="row in taskRows" :key="row.key" class="tk-task">
        <span class="tk-dot" :class="{ on: row.present, warn: row.issues > 0 }"></span>
        <span class="tk-name">{{ row.label }}</span>
        <span class="tk-prog">
          <template v-if="row.progress && row.progress.total > 0">
            {{ row.progress.done }}/{{ row.progress.total }}{{ row.progress.unit === 'frames' ? ' 帧' : ' 项' }}
          </template>
          <template v-else-if="row.progress && row.progress.done > 0">{{ row.progress.done }} 项</template>
          <template v-else>未开始</template>
        </span>
        <span v-if="row.issues" class="tk-badge">{{ row.issues }}</span>
      </li>
    </ul>
    <div v-if="taskIssues.length" class="tk-issues">
      <div v-for="(i, k) in taskIssues.slice(0, 4)" :key="k" class="tk-issue" :class="i.severity">
        {{ i.message }}
      </div>
    </div>

    <!-- ---------------- 占据 ---------------- -->
    <h3 class="tk-sec">占据栅格</h3>
    <div class="tk-kv">
      <span>规格</span><b>{{ specText }}</b>
    </div>
    <div class="tk-kv">
      <span>覆盖</span><b>{{ coverageText }}</b>
    </div>
    <div class="tk-kv">
      <span>本帧占据率</span><b>{{ ratioText }}</b>
    </div>
    <div v-if="occTop.length" class="tk-classes">
      <span v-for="c in occTop" :key="c.classId" class="tk-class-chip">{{ c.classId }} {{ c.count }}</span>
      <span v-if="occRest" class="tk-class-chip tk-class-rest">其余 {{ occRest.classes }} 类 {{ occRest.count }}</span>
    </div>
    <div class="tk-row">
      <button class="ghost" :disabled="!!occBusy" @click="genScope('frame')">生成本帧</button>
      <button class="ghost" :disabled="!!occBusy" @click="genScope('all')">生成全段</button>
      <button class="ghost" :disabled="!hasOcc" @click="clearOccupancy">清除</button>
    </div>
    <div v-if="occBusy" class="tk-busy">{{ occBusy }}</div>
    <div v-else-if="occNote" class="hint-small">{{ occNote }}</div>

    <label class="check-row"> <input :checked="showOcc" type="checkbox" @change="toggleOcc" /> 显示占据层 </label>

    <template v-if="showOcc">
      <div class="tk-slice">
        <div class="tk-slice-head">
          <span>高度切片</span><b>{{ sliceLow.toFixed(1) }} – {{ sliceHigh.toFixed(1) }} m</b>
        </div>
        <label class="tk-range">
          <span>下</span>
          <input
            type="range"
            :min="zMin"
            :max="zMax"
            step="0.4"
            :value="sliceLow"
            @input="setSlice(Number(($event.target as HTMLInputElement).value), sliceHigh)"
          />
        </label>
        <label class="tk-range">
          <span>上</span>
          <input
            type="range"
            :min="zMin"
            :max="zMax"
            step="0.4"
            :value="sliceHigh"
            @input="setSlice(sliceLow, Number(($event.target as HTMLInputElement).value))"
          />
        </label>
      </div>

      <div class="tk-paint">
        <div class="tk-slice-head">
          <span>ROI 单格修正</span>
          <b>{{
            cursor ? `光标 ${cursor.x.toFixed(1)}, ${cursor.y.toFixed(1)}, ${cursor.z.toFixed(1)}` : '光标不在点云上'
          }}</b>
        </div>
        <div class="tk-row">
          <select v-model="paintClass" class="tk-select">
            <option v-for="c in categories" :key="c.name" :value="c.name">{{ c.name }}</option>
            <option v-if="!categories.length" value="Car">Car</option>
          </select>
          <button class="ghost" :disabled="!hasOcc" @click="paint('add')">补一格</button>
          <button class="ghost" :disabled="!hasOcc" @click="paint('remove')">删一格</button>
        </div>
        <div class="hint-small">第 {{ frameNumber() }} 帧 · 鼠标移到点云上取坐标 · 每格都是一条可撤销命令</div>
      </div>

      <div class="tk-row">
        <button class="ghost" :disabled="!hasOcc" @click="exportOccupancy">导出 .occ + spec</button>
      </div>
    </template>

    <!-- ---------------- 光流 ---------------- -->
    <h3 class="tk-sec">光流 / 自车运动</h3>
    <div class="tk-row">
      <button class="ghost" :disabled="!!occBusy" @click="estimateEgo">估计自车运动</button>
      <button class="ghost" :class="{ active: showFlow }" @click="toggleFlow">箭头</button>
    </div>
    <div v-if="egoText" class="tk-kv">
      <span>本帧估计</span><b class="tk-mono">{{ egoText }}</b>
    </div>
    <div v-if="flowNote" class="hint-small">{{ flowNote }}</div>
    <div class="hint-small">箭头来自"上一帧框内点 → 刚体预测位置"；逐点光流按设计不落盘，导出时按需生成</div>

    <!-- ---------------- 跨任务一致性 ---------------- -->
    <h3 class="tk-sec">跨任务一致性</h3>
    <div class="tk-row">
      <button class="ghost" :disabled="checkBusy || !hasOcc" @click="check('current')">校验本帧</button>
      <button class="ghost" :disabled="checkBusy || !hasOcc" @click="check('all')">校验前 24 帧</button>
    </div>
    <div v-if="lastCheck" class="tk-kv">
      <span>结果</span>
      <b :class="issues.length ? 'qa-warn' : 'qa-good'"> {{ lastCheck.checked }} 帧 · {{ issues.length }} 问题 </b>
    </div>
    <ul v-if="issues.length" class="tk-issue-list">
      <li
        v-for="(i, k) in issues.slice(0, 12)"
        :key="k"
        class="tk-issue-line"
        :class="i.severity"
        :title="i.fixHint || ''"
        @click="gotoIssue(i)"
      >
        <span class="tk-code">{{ i.code }}</span>
        <span class="tk-msg">{{ i.message }}</span>
      </li>
    </ul>
    <div v-else-if="lastCheck" class="hint-small">没有发现跨任务冲突</div>
    <div class="hint-small">
      I1 框内占据率 / I2 框内类别一致 / I3 语义实例映射不悬空。 跨任务的 I4 光流刚体误差 / I5
      车道线落在可行驶区域内，留到 P5 规则引擎 （光流本身的可靠性由「任务」页的 TASK_FLOW_UNRELIABLE 单独报）。
    </div>
  </section>
</template>
