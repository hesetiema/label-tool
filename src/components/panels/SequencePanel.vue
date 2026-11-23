<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const {
  frames, currentFrame, showTrajectories, isPlaying, playSpeed, temporalReport, trackDemo,
  issueTypeName, gotoFrame, doInterpolate, toggleTrajectories, togglePlay, onSpeedChange,
  runTemporalQA, runOcclusionDemo, runTemporalDemo, gotoIssueFrame, runTrackingDemo,
  loadSequence,
} = studio
</script>

<template>
  <!-- 没有帧序列时给一个加载入口，否则切到「时序」Tab 会是一块空面板 -->
  <section v-if="!frames.length">
    <h3>时序帧</h3>
    <div class="hint-small">当前没有多帧序列。加载后可以逐帧切换、轨迹叠加、插值补全、跨帧传播与时序质检。</div>
    <button class="ghost wide" @click="loadSequence">加载 5 帧演示序列</button>
  </section>
  <section v-else>
    <h3>时序帧 <span class="count">{{ frames.length }}</span></h3>
    <div class="timeline">
      <button :disabled="currentFrame === 0" @click="gotoFrame(currentFrame - 1)">◀</button>
      <button
        v-for="(_f, i) in frames"
        :key="i"
        :class="{ active: currentFrame === i }"
        @click="gotoFrame(i)"
      >{{ i + 1 }}</button>
      <button :disabled="currentFrame === frames.length - 1" @click="gotoFrame(currentFrame + 1)">▶</button>
    </div>
    <button class="ghost wide" @click="doInterpolate">⟲ 轨迹插值补全</button>
    <div class="hint-small">前 3 个目标逐帧标注，后 3 个只标首末帧 —— 插值可自动补全中间帧</div>

    <!-- 4D 轨迹叠加回放 -->
    <div class="replay-box">
      <div class="replay-row">
        <button
          class="ghost"
          :class="{ active: showTrajectories }"
          @click="toggleTrajectories"
        >{{ showTrajectories ? '◉ 轨迹已显示' : '◌ 显示轨迹' }}</button>
        <button class="play-btn" @click="togglePlay">{{ isPlaying ? '⏸ 暂停' : '▶ 回放' }}</button>
      </div>
      <div class="replay-row">
        <label>速度</label>
        <select :value="playSpeed" @change="onSpeedChange">
          <option value="1.2">慢</option>
          <option value="0.6">中</option>
          <option value="0.25">快</option>
        </select>
        <span class="replay-hint">同目标跨帧连成轨迹线，白点=当前帧</span>
      </div>
    </div>

    <!-- 4D 时序质检 -->
    <div class="temporal-box">
      <div class="replay-row">
        <button class="ghost" @click="runTemporalQA">✓ 时序质检</button>
        <button class="ghost" @click="runTemporalDemo">⚠ 演示缺陷注入</button>
      </div>
      <div class="replay-row" style="margin-top:6px">
        <button class="ghost" @click="runOcclusionDemo">◐ 演示遮挡标记</button>
      </div>
      <div v-if="temporalReport" class="temporal-report">
        <div class="qa-row">
          <span>健康分</span>
          <b :class="temporalReport.score >= 80 ? 'qa-good' : 'qa-warn'">{{ temporalReport.score }} / 100</b>
        </div>
        <div class="temporal-summary">
          <span>ID跳变 {{ temporalReport.counts.id_switch }}</span>
          <span>速度突变 {{ temporalReport.counts.speed_jump }}</span>
          <span>抖动 {{ temporalReport.counts.jitter }}</span>
          <span>断裂 {{ temporalReport.counts.track_gap }}</span>
          <span>遮挡 {{ temporalReport.occludedPoints }}</span>
        </div>
        <div class="temporal-issues">
          <div
            v-for="(issue, i) in temporalReport.issues"
            :key="i"
            class="temporal-issue"
            :class="issue.severity"
            @click="gotoIssueFrame(issue.frame)"
            :title="'跳到第 ' + (issue.frame + 1) + ' 帧'"
          >
            <span class="issue-tag">{{ issueTypeName(issue.type) }}</span>
            <span class="issue-detail">{{ issue.detail }}</span>
          </div>
          <div v-if="!temporalReport.issues.length" class="issue-clean">✓ 未发现时序异常</div>
        </div>
      </div>
    </div>
    <button class="ghost wide" style="margin-top:8px" @click="runTrackingDemo">⚯ 贪心 vs Hungarian 关联演示</button>
    <div v-if="trackDemo" class="track-demo">
      <div class="qa-row"><span>观测距离（上一帧→当前帧）</span></div>
      <div class="track-mono">{{ trackDemo.costText }}</div>
      <div class="qa-row"><span>贪心最近邻</span><b class="qa-warn">{{ trackDemo.greedyText }}</b></div>
      <div class="qa-row"><span>Kalman+Hungarian</span><b class="qa-good">{{ trackDemo.kalmanText }}</b></div>
      <div class="qa-row"><span>门控拒绝的错误配对</span><b>{{ trackDemo.gated }}</b></div>
      <div class="track-conclusion">{{ trackDemo.greedySwapped ? '贪心总距离=0 却把两个 ID 串了；Kalman 用速度预测出正确位置' : '两种算法结果一致' }}</div>
    </div>
  </section>
</template>
