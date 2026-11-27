<script setup lang="ts">
import { inject } from 'vue'
import { StudioKey } from '../../state/studioContext'

const studio = inject(StudioKey)!
const { qaReport, showReview, pct, runQualityCheck, toggleReviewOverlay } = studio
</script>

<template>
  <section>
    <h3>质检与一致性</h3>
    <button class="ghost wide" @click="runQualityCheck">✓ 生成质检报告</button>
    <button v-if="qaReport" class="ghost wide" @click="toggleReviewOverlay">
      {{ showReview ? '◌ 隐藏' : '◉ 显示' }}待评估框
    </button>
    <div v-if="qaReport" class="qa-report">
      <div class="qa-row">
        <span>匹配 / 漏标 / 误标</span
        ><b>{{ qaReport.matched.length }} / {{ qaReport.missed.length }} / {{ qaReport.spurious.length }}</b>
      </div>
      <div class="qa-row">
        <span>平均 IoU（边界精度）</span><b>{{ qaReport.metrics.meanIoU.toFixed(2) }}</b>
      </div>
      <div class="qa-row">
        <span>BEV IoU</span><b>{{ qaReport.metrics.meanBevIoU.toFixed(2) }}</b>
      </div>
      <div class="qa-row">
        <span>召回率 / 精确率</span><b>{{ pct(qaReport.metrics.recall) }} / {{ pct(qaReport.metrics.precision) }}</b>
      </div>
      <div class="qa-row">
        <span>F1</span><b>{{ qaReport.metrics.f1.toFixed(2) }}</b>
      </div>
      <div class="qa-row">
        <span>类别一致性 kappa</span
        ><b :class="qaReport.metrics.kappa >= 0.8 ? 'qa-good' : 'qa-warn'">{{ qaReport.metrics.kappa.toFixed(2) }}</b>
      </div>
      <div class="qa-row">
        <span>中心误差 / 朝向误差</span
        ><b>{{ qaReport.metrics.centerError.toFixed(2) }}m / {{ qaReport.metrics.yawError.toFixed(2) }}rad</b>
      </div>
    </div>
    <div class="hint-small">用当前标注作基准，生成一份扰动版模拟"新人标注 / 模型预标注"，再量化差异</div>
  </section>
</template>
