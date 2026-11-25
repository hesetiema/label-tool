<script setup lang="ts">
/**
 * VLA 面板：指令段 + 动作通道 + 对齐校验
 *
 * 设计取舍：
 *   - 指令列表是主体，动作曲线在**底部时间线**里画，不在这里画。
 *     曲线要和帧游标、和轨迹条对齐才有意义，塞进 300px 宽的侧栏就只是装饰。
 *   - 区间用两个数字框而不是滑块：VLA 的区间要精确到帧（"第 173 帧起转"），
 *     滑块给不了这个精度，拖拽在时间线上另有入口。
 *   - 文本编辑在失焦/回车时提交一条命令，不逐字提交 —— 否则打 20 个字就是 20 条历史。
 *   - 生成的演示数据默认干净，"注入错误"是显式开关：让用户能自己看规则真的会响。
 */
import { computed, inject, ref, watch } from 'vue'
import { StudioKey } from '../../state/studioContext'
import { VLA_DEMO_ERRORS } from '../../state/useVla'

const studio = inject(StudioKey)!
const {
  vla, instructions, selected, vlaSelectedId, currentInstruction,
  vlaIssues, vlaIssueGroups, vlaBlockers, coverage, pendingCount, taskSummary, alignInfo,
  showVlaTimeline, vlaBusy, demoErrors, checkOptions, lastImport,
  editRange, editText, addAtGap, addAtFrame, removeSelected, setReview, acceptAll,
  resetAlign, shiftAlign, setHz, setSign, toggleChannel, channelVisible,
  loadDemo, toggleDemoError, importJsonl, exportJsonl, clearVla,
  gotoInstruction, selectAtCurrentFrame, channels, frameNumber,
} = studio

const fileInput = ref<HTMLInputElement | null>(null)

/** 文本编辑缓冲：失焦或回车才提交，避免逐字进历史 */
const textDraft = ref('')
watch(selected, (s) => { textDraft.value = s?.text ?? '' }, { immediate: true })

const startDraft = ref(0)
const endDraft = ref(0)
watch(selected, (s) => {
  startDraft.value = s?.startFrame ?? 0
  endDraft.value = s?.endFrame ?? 0
}, { immediate: true })

function commitText() {
  const s = selected.value
  if (!s || textDraft.value === s.text) return
  editText(s.id, textDraft.value)
}

function commitRange() {
  const s = selected.value
  if (!s) return
  if (startDraft.value === s.startFrame && endDraft.value === s.endFrame) return
  editRange(s.id, Number(startDraft.value), Number(endDraft.value))
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) void importJsonl(file)
  input.value = ''
}

const summaryText = computed(() => {
  const s = taskSummary.value
  if (!s) return '未启用'
  return `${s.segments} 段 · ${s.channels} 通道 · ${s.frames} 帧 / ${s.seconds.toFixed(1)}s @ ${s.hz}Hz`
})

const coverageText = computed(() => (instructions.value.length ? `${Math.round(coverage.value * 100)}%` : '—'))

const offsetText = computed(() => {
  const a = alignInfo.value
  if (!a) return '—'
  const sign = a.offset > 0 ? '+' : ''
  return `${sign}${a.offset} 帧（${sign}${a.seconds.toFixed(2)}s）`
})

const scanText = computed(() => checkOptions.value.checkTextDup ? '含相邻重复文本' : '标准 8 条')

const reviewLabel: Record<string, string> = {
  none: '人工',
  pending: '待确认',
  accepted: '已确认',
  rejected: '已拒绝',
  conflict: '冲突',
}

const signTags = computed(() => Object.entries(vla.value?.signMap ?? {}))
</script>

<template>
  <section class="vla-panel">
    <h3>VLA 对齐 <span class="count">{{ instructions.length }}</span></h3>

    <div class="vla-kv"><span>概要</span><b>{{ summaryText }}</b></div>
    <div class="vla-kv"><span>指令覆盖</span><b :class="coverage >= 0.999 ? 'qa-good' : 'qa-warn'">{{ coverageText }}</b></div>
    <div class="vla-kv"><span>问题</span>
      <b :class="vlaBlockers ? 'qa-warn' : (vlaIssueGroups.length ? '' : 'qa-good')">
        {{ vlaBlockers ? `${vlaBlockers} 必须修` : (vlaIssueGroups.length ? `${vlaIssueGroups.length} 类提示` : (vla ? '无' : '—')) }}
      </b>
    </div>

    <div class="vla-row">
      <button class="ghost" :disabled="!!vlaBusy" @click="loadDemo">生成演示</button>
      <button class="ghost" :disabled="!!vlaBusy" @click="fileInput?.click()">导入 JSONL</button>
      <button class="ghost" :disabled="!vla" @click="exportJsonl">导出 JSONL</button>
      <button class="ghost" :disabled="!vla" @click="clearVla">清除</button>
    </div>
    <input ref="fileInput" type="file" accept=".jsonl,.json,.ndjson,text/plain" class="vla-file" @change="onFile" />
    <div v-if="vlaBusy" class="vla-busy">{{ vlaBusy }}</div>
    <div v-else-if="lastImport" class="hint-small">上次导入：{{ lastImport }}</div>

    <!-- 演示数据的错误注入：默认全关，勾上就知道对应规则确实会响 -->
    <details class="vla-details">
      <summary>注入演示错误（{{ demoErrors.length }}）</summary>
      <label v-for="e in VLA_DEMO_ERRORS" :key="e.key" class="check-row">
        <input type="checkbox" :checked="demoErrors.includes(e.key)" @change="toggleDemoError(e.key)" />
        <span>{{ e.label }}</span>
        <span class="vla-hint">{{ e.hint }}</span>
      </label>
      <div class="hint-small">勾选后重新点「生成演示」。默认干净数据是基线：0 问题。</div>
    </details>

    <template v-if="vla">
      <!-- ---------------- 指令列表 ---------------- -->
      <h3 class="vla-sec">指令段</h3>
      <div class="vla-row">
        <button class="ghost" @click="addAtGap">补空档</button>
        <button class="ghost" @click="addAtFrame(frameNumber())">在第 {{ frameNumber() }} 帧新增</button>
        <button class="ghost" @click="selectAtCurrentFrame">选中当前帧</button>
        <button class="ghost" :disabled="!pendingCount" @click="acceptAll">全部确认 {{ pendingCount || '' }}</button>
      </div>

      <ul class="vla-list">
        <li
          v-for="s in instructions"
          :key="s.id"
          class="vla-item"
          :class="{ on: s.id === vlaSelectedId, now: currentInstruction?.id === s.id }"
          @click="gotoInstruction(s.id)"
        >
          <div class="vla-item-head">
            <span class="vla-item-text">{{ s.text || '（空）' }}</span>
            <span class="vla-item-range">{{ s.startFrame }}–{{ s.endFrame }}</span>
          </div>
          <div class="vla-item-meta">
            <span v-for="t in s.tags ?? []" :key="t" class="vla-tag">{{ t }}</span>
            <span class="vla-review" :class="s.review">{{ reviewLabel[s.review] ?? s.review }}</span>
            <span v-if="s.source.kind === 'model'" class="vla-src">model</span>
          </div>
        </li>
        <li v-if="!instructions.length" class="hint-small">还没有指令段：点「生成演示」或导入 JSONL</li>
      </ul>

      <!-- ---------------- 选中详情 ---------------- -->
      <template v-if="selected">
        <h3 class="vla-sec">选中 #{{ selected.id }}</h3>
        <label class="vla-field">
          <span>文本</span>
          <input
            v-model="textDraft" type="text" class="vla-input"
            placeholder="例如：前方路口左转"
            @blur="commitText" @keyup.enter="commitText"
          />
        </label>
        <div class="vla-field">
          <span>区间</span>
          <div class="vla-range">
            <input v-model.number="startDraft" type="number" class="vla-num" @change="commitRange" />
            <span class="vla-dash">–</span>
            <input v-model.number="endDraft" type="number" class="vla-num" @change="commitRange" />
          </div>
        </div>
        <div class="vla-kv"><span>对齐偏移</span><b class="vla-mono">{{ offsetText }}</b></div>
        <div class="vla-row">
          <button class="ghost" title="动作区间整体前移 1 帧" @click="shiftAlign(selected.id, -1)">−1</button>
          <button class="ghost" title="动作区间整体后移 1 帧" @click="shiftAlign(selected.id, 1)">+1</button>
          <button class="ghost" @click="resetAlign(selected.id)">对齐回区间</button>
          <button class="ghost" :disabled="selected.review === 'accepted'" @click="setReview(selected.id, 'accepted')">确认</button>
          <button class="ghost" :disabled="selected.review === 'rejected'" @click="setReview(selected.id, 'rejected')">拒绝</button>
          <button class="ghost danger" @click="removeSelected">删除</button>
        </div>
        <div class="hint-small">
          对齐偏移是标出来的：指令说"左转"，动作可能晚 0.6 秒才开始。
          改指令区间不会顺带搬对齐区间 —— 那等于把标过的结论抹掉。
        </div>
      </template>

      <!-- ---------------- 通道 ---------------- -->
      <h3 class="vla-sec">动作通道</h3>
      <div class="vla-chips">
        <button
          v-for="c in channels" :key="c.name"
          class="vla-chip" :class="{ off: !channelVisible(c.name) }"
          :title="`${c.unit} · ${c.values.length} 帧 · 源 ${c.sourceHz}Hz`"
          @click="toggleChannel(c.name)"
        >{{ c.name }}</button>
      </div>
      <div class="vla-kv">
        <span>帧率</span>
        <b>
          <input
            :value="vla.hz" type="number" min="1" max="120" step="1" class="vla-num"
            @change="setHz(Number(($event.target as HTMLInputElement).value))"
          /> Hz
        </b>
      </div>
      <div class="hint-small">帧率只用于"秒"的换算（滞后 0.5s、抖动门禁）；内部一律帧号</div>

      <details class="vla-details">
        <summary>符号约定（{{ signTags.length }}）</summary>
        <div v-for="[tag, sign] in signTags" :key="tag" class="vla-kv">
          <span>{{ tag }}</span>
          <span class="vla-seg">
            <button :class="{ on: sign === 'negative' }" @click="setSign(tag, 'negative')">steer &lt; 0</button>
            <button :class="{ on: sign === 'positive' }" @click="setSign(tag, 'positive')">steer &gt; 0</button>
            <button :class="{ on: sign === 'zero' }" @click="setSign(tag, 'zero')">≈0</button>
          </span>
        </div>
        <div class="hint-small">
          左转为负、右转为正是本项目的约定，不是普适真理。换数据集时先核对这一栏，
          否则 VLA_ACTION_SIGN 会全量误报。
        </div>
      </details>

      <!-- ---------------- 校验 ---------------- -->
      <h3 class="vla-sec">对齐校验</h3>
      <div class="vla-row">
        <label class="check-row">
          <input v-model="checkOptions.checkTextDup" type="checkbox" /> 查相邻重复文本
        </label>
        <span class="vla-hint">{{ scanText }}</span>
      </div>
      <div v-if="vlaIssueGroups.length" class="vla-groups">
        <span v-for="g in vlaIssueGroups" :key="g.code" class="vla-group" :class="g.severity">
          {{ g.code }} <b>{{ g.count }}</b>
        </span>
      </div>
      <ul v-if="vlaIssues.length" class="vla-issues">
        <li v-for="(i, k) in vlaIssues.slice(0, 14)" :key="k" class="vla-issue" :class="i.severity" :title="i.fixHint || ''">
          <span class="vla-code">{{ i.code }}</span>
          <span class="vla-msg">{{ i.message }}</span>
        </li>
      </ul>
      <div v-else-if="vla" class="hint-small qa-good">没有发现问题</div>

      <label class="check-row">
        <input v-model="showVlaTimeline" type="checkbox" /> 在时间线上显示指令与曲线
      </label>
    </template>
  </section>
</template>
