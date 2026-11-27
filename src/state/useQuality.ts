/**
 * ============================================================
 * 质检与性能演示
 * ============================================================
 * 三件事：
 *   1. 标注质检：用确定性扰动造一份"待评估版本"，量化 IoU / kappa / 漏标
 *   2. 关联演示：贪心最近邻串 ID vs Hungarian+Kalman，证明后者的必要性
 *   3. 性能压测：100 万点 → 体素下采样 → 距离 LOD，用实测 FPS 说话
 */
import { ref, nextTick } from 'vue'
import { voxelDownsample, distanceLod, generateMassiveCloud } from '../core/geometry/downsample'
import { evaluateQuality, perturbLabels } from '../core/quality/quality'
import { demoCrossingCase } from '../core/sequence/tracker'
import type { StudioCore } from './studioCore'

export function useQuality(core: StudioCore) {
  const {
    boxes,
    selectedId,
    cloud,
    frames,
    calib,
    imageUrl,
    reviewBoxes,
    qaReport,
    showReview,
    statusText,
    resetHistory,
    syncViewer,
    setLayout,
    invalidateCloud,
    getViewer,
  } = core

  // ---- 性能压测 ----
  const perfBusy = ref(false)
  const perfStats = ref('')

  // ---- 关联算法对比 ----
  const trackDemo = ref<{
    costText: string
    greedyText: string
    kalmanText: string
    greedySwapped: boolean
    kalmanCorrect: boolean
    gated: number
  } | null>(null)

  /** 百分比显示（指标面板统一格式） */
  function pct(v: number): string {
    return `${Math.round(v * 100)}%`
  }

  /**
   * 生成"待评估版本"并计算质检报告。
   *
   * 把当前标注当作 ground truth，用确定性扰动生成第二版标注
   * （模拟新人标注或模型预标注），然后跑完整的质检测量链路。
   * 真实系统里，这两份数据分别来自「质检员复核结果」和「待验收标注」。
   */
  function runQualityCheck() {
    if (!boxes.value.length) {
      statusText.value = '质检需要至少有标注框（先加载演示场景或真实数据）'
      return
    }
    reviewBoxes.value = perturbLabels(boxes.value)
    qaReport.value = evaluateQuality(boxes.value, reviewBoxes.value)
    showReview.value = true
    syncViewer() // 会把待评估框一起渲染，方便肉眼对照差异
    const m = qaReport.value.metrics
    statusText.value = `质检完成：${qaReport.value.matched.length} 框匹配 · IoU ${m.meanIoU.toFixed(2)} · kappa ${m.kappa.toFixed(2)} · 漏标 ${pct(m.missRate)}`
  }

  /** 显示/隐藏待评估框的叠加层 */
  function toggleReviewOverlay() {
    showReview.value = !showReview.value
    syncViewer()
  }

  /**
   * 演示"贪心最近邻串 ID vs Hungarian+Kalman 正确保持"的经典交叉案例。
   *
   * 两车相向而行 0.5 秒后交叉换位：
   *   纯距离贪心会给出总距离 0 的"完美匹配"，但两个 ID 完全串了；
   *   Kalman 用速度预测出正确位置，Hungarian 给出同样距离 0 但 ID 正确的配对。
   */
  function runTrackingDemo() {
    const d = demoCrossingCase()
    const fmt = (a: { row: number; col: number }[]) =>
      a.length ? a.map((x) => `轨迹${x.row}→检测${x.col}`).join('，') : '无匹配'
    // row0=A(原左车) 应该配 col0(x=12)，row1=B(原右车) 应该配 col1(x=8)
    const greedySwapped = d.greedy.some((a) => (a.row === 0 && a.col === 1) || (a.row === 1 && a.col === 0))
    const kalmanCorrect = d.kalman.assignments.some((a) => (a.row === 0 && a.col === 0) || (a.row === 1 && a.col === 1))
    trackDemo.value = {
      // 两个成本矩阵之间的分隔用全角空格（等宽排版对齐），写成转义避免不可见字符
      costText: `A(8)→检测 ${d.cost[0].map((x) => x.toFixed(0)).join(' / ')}\u3000B(12)→检测 ${d.cost[1].map((x) => x.toFixed(0)).join(' / ')}`,
      greedyText: fmt(d.greedy),
      kalmanText: fmt(d.kalman.assignments),
      greedySwapped,
      kalmanCorrect,
      gated: d.kalman.gated,
    }
    statusText.value =
      greedySwapped && kalmanCorrect
        ? '关联演示：贪心把两个 ID 串了（总距离却是 0），Kalman+Hungarian 正确保持'
        : '关联演示已运行'
  }

  /** 用 requestAnimationFrame 实测渲染帧率 —— 用数据说话，而不是凭感觉说"优化后更快" */
  function measureFps(durationMs = 1500): Promise<number> {
    return new Promise((resolve) => {
      let n = 0
      const start = performance.now()
      const tick = () => {
        n++
        const dt = performance.now() - start
        if (dt < durationMs) requestAnimationFrame(tick)
        else resolve(Math.round((n * 1000) / dt))
      }
      requestAnimationFrame(tick)
    })
  }

  /** 百万点性能压测：原始 → 体素下采样 → 距离 LOD → 实测 FPS */
  async function runPerfTest() {
    if (perfBusy.value) return
    perfBusy.value = true
    statusText.value = '正在生成 100 万点…'
    await nextTick()
    const raw = generateMassiveCloud(1_000_000)
    statusText.value = '体素下采样 + 距离 LOD 处理中…'
    await nextTick()
    const voxel = voxelDownsample(raw, 0.5)
    const lod = distanceLod(voxel.cloud, { nearRadius: 45, farKeep: 0.5 })

    frames.value = []
    calib.value = null
    imageUrl.value = ''
    setLayout('cloud')
    cloud.value = lod.cloud
    boxes.value = []
    selectedId.value = null
    resetHistory()
    invalidateCloud()
    syncViewer()
    getViewer()?.focusOnCloud(cloud.value)

    const fps = await measureFps(1500)
    const fmt = (n: number) => n.toLocaleString()
    perfStats.value = `${fmt(raw.count)} → 体素 ${fmt(voxel.outputCount)}（${voxel.elapsedMs.toFixed(0)}ms）→ LOD ${fmt(lod.outputCount)}（${lod.elapsedMs.toFixed(0)}ms）· ${fps} FPS`
    statusText.value = `性能压测完成：${fmt(lod.outputCount)} 点 @ ${fps} FPS`
    perfBusy.value = false
  }

  return {
    perfBusy,
    perfStats,
    trackDemo,
    pct,
    runQualityCheck,
    toggleReviewOverlay,
    runTrackingDemo,
    runPerfTest,
  }
}
