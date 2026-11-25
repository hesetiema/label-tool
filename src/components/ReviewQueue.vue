<script setup lang="ts">
/**
 * 预标注复核队列。
 *
 * 【为什么要有独立面板】模型一次可能产出几十条轨迹、几百帧。只靠画布点选，
 * 人会被"哪条还没看"淹没。面板把「谁待裁决、置信度多少、有没有冲突」排成
 * 一列，按"冲突优先、低置信在前"排序，复核就变成了从上往下走一遍。
 *
 * 【快捷键】面板打开期间：A 接受 / X 拒绝 / Shift+A 接受当前帧 / Tab 下一处 / Esc 关闭。
 * 关掉面板这些键立刻还给画布（A 仍然是沿 +y 平移）。
 */
import { computed, inject, onBeforeUnmount } from 'vue'
import { StudioKey } from '../state/studioContext'
import type { MergeStrategy } from '../domain/ops/mergePreLabel'

const studio = inject(StudioKey)!
const {
  reviewOpen, reviewRows, reviewStats, selectedTrackId, policy, running, progress, lastModel, lastError,
  closeReview, refresh, selectRow, nextPending, firstPending,
  acceptSelected, rejectSelected, acceptAll, rejectAll, decideRow, acceptInFrame,
  runMock, setStrategy, setMinConfidence, strategyLabel,
} = studio

const strategies: MergeStrategy[] = ['append', 'fill-gaps', 'replace-track', 'class-vote']

const pct = computed(() => Math.round(progress.value * 100))

function pctOf(v: number): string {
  return `${Math.round(v * 100)}%`
}

// 面板内也要能 Esc 关闭：与全局捕获监听并存不冲突（都只调 closeReview，幂等）
function onKey(e: KeyboardEvent) {
  if (!reviewOpen.value) return
  if (e.key === 'Escape') closeReview()
}
window.addEventListener('keydown', onKey)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-if="reviewOpen" class="modal-mask" @click.self="closeReview">
    <div class="modal rv-modal">
      <header class="modal-head">
        <h3>
          预标注复核
          <span class="lib-count">{{ reviewStats.tracks }}</span>
          <span v-if="reviewStats.conflicts" class="rv-conflict-chip">{{ reviewStats.conflicts }} 帧冲突</span>
        </h3>
        <div class="lib-head-right">
          <span v-if="lastModel" class="rv-model" :title="lastModel">{{ lastModel }}</span>
          <button class="mini-icon" title="重新读取" @click="refresh">⟳</button>
          <button class="mini-icon" @click="closeReview">✕</button>
        </div>
      </header>

      <div class="lib-body">
        <div v-if="running" class="rv-progress">
          <div class="rv-bar"><i :style="{ width: pct + '%' }"></i></div>
          <span>推理中 {{ pct }}%</span>
        </div>
        <p v-if="lastError" class="lib-error">{{ lastError }}</p>

        <div class="rv-policy">
          <label>
            合并策略
            <select :value="policy.strategy" @change="setStrategy(($event.target as HTMLSelectElement).value as MergeStrategy)">
              <option v-for="s in strategies" :key="s" :value="s">{{ strategyLabel(s) }}</option>
            </select>
          </label>
          <label>
            置信度下限
            <input
              type="number" min="0" max="0.99" step="0.05"
              :value="policy.minConfidence"
              @change="setMinConfidence(Number(($event.target as HTMLInputElement).value))"
            />
          </label>
          <span class="rv-hint">策略只影响下一次合并；已合入的用 Ctrl+Z 退回</span>
        </div>

        <p v-if="!reviewRows.length" class="lib-empty">
          没有待裁决的模型产出。先跑一次预标注：菜单 → 预标注 → 演示模型，
          或导入离线结果 JSON。
        </p>

        <ul v-else class="rv-list">
          <li
            v-for="r in reviewRows"
            :key="r.trackId"
            class="rv-row"
            :class="{ on: r.trackId === selectedTrackId, conflict: r.review === 'conflict' }"
            @click="selectRow(r.trackId)"
          >
            <div class="rv-main">
              <div class="rv-title">
                <span class="rv-class">{{ r.classId }}</span>
                <span class="rv-id">#{{ r.trackId }}</span>
                <span v-if="r.review === 'conflict'" class="lib-tag danger">冲突</span>
              </div>
              <div class="rv-meta">
                <span>{{ r.frames.length }} 帧</span>
                <span class="lib-sep">·</span>
                <span>{{ r.frames[0] }}–{{ r.frames[r.frames.length - 1] }}</span>
                <span class="lib-sep">·</span>
                <span :class="['rv-conf', r.confidence < 0.6 ? 'low' : '']">置信度 {{ pctOf(r.confidence) }}</span>
              </div>
            </div>
            <div class="lib-actions">
              <button class="lib-btn" @click.stop="decideRow(r.trackId, 'accepted')">接受</button>
              <button class="lib-btn danger-ghost" @click.stop="decideRow(r.trackId, 'rejected')">拒绝</button>
            </div>
          </li>
        </ul>

        <p class="lib-note">
          A 接受选中 · X 拒绝 · Shift+A 接受当前帧 · Tab 下一处。
          待复核的框在画布上是<strong>灰色虚线</strong>，且不会进入导出 —— 导出只含已接受与人工标注。
          裁决本身是一条命令，Ctrl+Z 可退回。
        </p>
      </div>

      <footer class="rv-foot">
        <button class="lib-btn" :disabled="!reviewRows.length" @click="firstPending">从头开始</button>
        <button class="lib-btn" :disabled="!reviewRows.length" @click="nextPending">下一处</button>
        <button class="lib-btn" :disabled="!reviewRows.length" @click="acceptInFrame">接受当前帧</button>
        <span class="rv-grow"></span>
        <button class="lib-btn" :disabled="!reviewRows.length" @click="acceptSelected">接受选中</button>
        <button class="lib-btn danger-ghost" :disabled="!reviewRows.length" @click="rejectSelected">拒绝选中</button>
        <button class="lib-btn" :disabled="!reviewRows.length" @click="acceptAll">全部接受</button>
        <button class="lib-btn" :disabled="!reviewRows.length" @click="rejectAll">全部拒绝</button>
        <button class="lib-btn" :disabled="running" @click="runMock">跑演示预标注</button>
      </footer>
    </div>
  </div>
</template>
