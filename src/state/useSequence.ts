/**
 * ============================================================
 * 多帧时序模块
 * ============================================================
 * 帧切换、逐帧回放、轨迹插值、4D 轨迹叠加、跨帧编辑传播、时序质检。
 *
 * 核心约束：boxes 是"当前帧的工作副本"，切帧前必须写回 frames[currentFrame]，
 * 否则切走再切回会丢修改。所有涉及帧的操作都遵守这一条。
 */
import { ref } from 'vue'
import { cloneBoxes } from '../core/history'
import {
  interpolateTracks, extractTrajectories, propagateBox, type PropagateScope,
} from '../core/sequence/sequence'
import { evaluateTemporal, injectTemporalDefects } from '../core/sequence/temporalQA'
import { strVal, type StudioCore } from './studioCore'

export function useSequence(core: StudioCore) {
  const {
    boxes, selectedId, cloud, frames, currentFrame, statusText, showTrajectories,
    temporalReport, origin, mutate, syncViewer, resetHistory, onReset,
  } = core

  // ---- 回放 ----
  const isPlaying = ref(false)
  const playSpeed = ref(0.6) // 每帧间隔（秒）
  let playTimer: number | undefined

  // ---- 4D 跨帧编辑 ----
  const propagateScope = ref<PropagateScope>('forward')
  const propagateStrategy = ref<'replace' | 'offset'>('offset')

  /** 停止回放（切数据集 / 卸载 / 手动暂停时调用） */
  function pausePlay() {
    if (playTimer !== undefined) {
      window.clearInterval(playTimer)
      playTimer = undefined
    }
    isPlaying.value = false
  }

  // 数据集切换（resetHistory 不带 keepPlayback）时必须停表
  onReset('playback', pausePlay)

  /** 切换帧：先把当前帧的编辑结果写回序列，否则切走再切回会丢失修改 */
  function gotoFrame(fi: number) {
    if (!frames.value.length) return
    const target = Math.max(0, Math.min(frames.value.length - 1, fi))
    if (target === currentFrame.value) return
    frames.value[currentFrame.value].boxes = cloneBoxes(boxes.value)
    currentFrame.value = target
    cloud.value = frames.value[target].cloud
    boxes.value = cloneBoxes(frames.value[target].boxes)
    selectedId.value = null
    origin.value = null
    // 跨帧撤销语义复杂，教学版切帧即清空历史；但不打断回放，也保留质检报告
    resetHistory({ keepPlayback: true, keepQA: true })
    syncViewer()
    statusText.value = `第 ${target + 1}/${frames.value.length} 帧 · ${boxes.value.length} 个框`
  }

  /** 逐帧回放：到末帧后从头循环，直到手动暂停 */
  function play() {
    if (frames.value.length < 2 || isPlaying.value) return
    isPlaying.value = true
    playTimer = window.setInterval(() => {
      const next = currentFrame.value + 1
      gotoFrame(next >= frames.value.length ? 0 : next)
    }, playSpeed.value * 1000)
  }

  function togglePlay() {
    if (isPlaying.value) {
      pausePlay()
      statusText.value = `回放已暂停 · 第 ${currentFrame.value + 1}/${frames.value.length} 帧`
    } else {
      play()
      statusText.value = `回放中 · ${frames.value.length} 帧循环 · 间隔 ${playSpeed.value}s`
    }
  }

  /** 调速时若正在播放，重启定时器以应用新间隔 */
  function onSpeedChange(e: Event) {
    playSpeed.value = Number((e.target as HTMLSelectElement).value)
    if (isPlaying.value) {
      pausePlay()
      play()
    }
  }

  /** 轨迹插值：用首末帧的框线性补全中间帧，obj_id 保持一致 */
  function doInterpolate() {
    if (!frames.value.length) return
    frames.value[currentFrame.value].boxes = cloneBoxes(boxes.value)
    const added = interpolateTracks(frames.value)
    boxes.value = cloneBoxes(frames.value[currentFrame.value].boxes)
    selectedId.value = null
    resetHistory()
    syncViewer()
    statusText.value = added > 0
      ? `轨迹插值完成：补出 ${added} 个中间帧框（obj_id 跨帧一致）`
      : '所有轨迹的中间帧都已完整，无需插值'
  }

  /** 4D 轨迹叠加开关 */
  function toggleTrajectories() {
    showTrajectories.value = !showTrajectories.value
    syncViewer()
    statusText.value = showTrajectories.value
      ? `轨迹叠加已开启：${extractTrajectories(frames.value).length} 条轨迹`
      : '轨迹叠加已关闭'
  }

  // ---- 跨帧传播 ----
  function onScopeChange(e: Event) { propagateScope.value = strVal(e) as PropagateScope }
  function onStrategyChange(e: Event) { propagateStrategy.value = strVal(e) as 'replace' | 'offset' }

  /**
   * 把选中框的当前修改传播到其他帧的同 id 框。
   * 用 origin（选中时的快照）作为"编辑前"基准，配合 propagateBox 计算增量或整框替换。
   */
  function doPropagate() {
    if (!frames.value.length || !selectedId.value) {
      statusText.value = '跨帧传播需要先加载帧序列，并选中一个框'
      return
    }
    const edited = boxes.value.find((b) => b.id === selectedId.value)
    if (!edited || !origin.value) {
      statusText.value = '请先选中一个框再传播'
      return
    }
    // 先把当前帧的编辑写回序列，再传播
    frames.value[currentFrame.value].boxes = cloneBoxes(boxes.value)
    const changed = propagateBox(
      frames.value,
      currentFrame.value,
      selectedId.value,
      origin.value,
      edited,
      propagateScope.value,
      propagateStrategy.value,
    )
    // 把传播后的当前帧重新读回（内容未变，保持引用一致）
    boxes.value = cloneBoxes(frames.value[currentFrame.value].boxes)
    origin.value = cloneBoxes([edited])[0] // 更新基准为"本次编辑后"
    resetHistory()
    syncViewer()
    const scopeText = { all: '全部帧', forward: '后续帧', backward: '前序帧' }[propagateScope.value]
    const strategyText = propagateStrategy.value === 'replace' ? '整框替换' : '增量平移'
    statusText.value = changed > 0
      ? `跨帧传播完成：${strategyText} → ${scopeText}，修改了 ${changed} 帧的目标 #${selectedId.value}`
      : `没有可传播的目标：${scopeText}里未找到 id=${selectedId.value} 的框`
  }

  // ---- 4D 时序质检 ----
  /** 对当前帧序列做 4D 一致性检查 */
  function runTemporalQA() {
    if (frames.value.length < 2) {
      statusText.value = '时序质检需要至少 2 帧（先加载序列演示）'
      return
    }
    // 确保当前帧编辑已写回
    frames.value[currentFrame.value].boxes = cloneBoxes(boxes.value)
    temporalReport.value = evaluateTemporal(frames.value)
    const r = temporalReport.value
    statusText.value = r.issues.length === 0
      ? `时序质检通过：${r.trackCount} 条轨迹、${r.frameCount} 帧，未发现异常`
      : `时序质检发现 ${r.issues.length} 处问题（ID跳变 ${r.counts.id_switch} / 速度突变 ${r.counts.speed_jump} / 抖动 ${r.counts.jitter} / 断裂 ${r.counts.track_gap}），健康分 ${r.score}`
  }

  /** 演示"显式标记遮挡"：把有 track_gap 的目标在当前帧标为 occluded，看健康分回升 */
  function runOcclusionDemo() {
    if (frames.value.length < 2) {
      statusText.value = '请先加载序列演示（至少 2 帧）'
      return
    }
    pausePlay()
    // 先把当前帧编辑写回，再对第一个有断裂的目标在缺口帧标记遮挡
    frames.value[currentFrame.value].boxes = cloneBoxes(boxes.value)
    const before = evaluateTemporal(frames.value)
    const gap = before.issues.find((i) => i.type === 'track_gap')
    if (!gap) {
      statusText.value = '当前序列没有轨迹断裂，无需标记遮挡。可先点「演示缺陷注入」制造断裂'
      temporalReport.value = before
      return
    }
    // 在断裂帧给该目标补一个 occluded 标记框（从种子框复制）
    const seed = frames.value[0]?.boxes.find((b) => b.id === gap.objId)
      ?? frames.value.find((fr) => fr.boxes.some((b) => b.id === gap.objId))?.boxes.find((b) => b.id === gap.objId)
    if (!seed) return
    frames.value[gap.frame].boxes.push({ ...cloneBoxes([seed])[0], visibility: 'occluded' })
    const after = evaluateTemporal(frames.value)
    temporalReport.value = after
    statusText.value = `已把 ${gap.objId} 在第 ${gap.frame} 帧标记为遮挡：健康分 ${before.score} → ${after.score}，该处断裂不再误报（遮挡点 ${after.occludedPoints} 个）`
    gotoFrame(gap.frame)
    syncViewer()
  }

  /** 把当前选中框切换 可见 / 遮挡 状态（插入历史，可撤销） */
  function toggleSelectedVisibility() {
    if (!selectedId.value) return
    const box = boxes.value.find((b) => b.id === selectedId.value)
    if (!box) return
    const next = box.visibility === 'occluded' ? 'visible' : 'occluded'
    mutate(`标记 ${selectedId.value} 为${next === 'occluded' ? '遮挡' : '可见'}`, () => {
      box.visibility = next
    })
    statusText.value = `目标 #${selectedId.value} 已标记为${next === 'occluded' ? '遮挡（虚线显示，质检不误报）' : '可见'}`
  }

  /** 注入时序缺陷并立即质检，用于演示四类问题 */
  function runTemporalDemo() {
    if (frames.value.length < 2) {
      statusText.value = '请先加载序列演示'
      return
    }
    pausePlay()
    const defective = injectTemporalDefects(frames.value)
    temporalReport.value = evaluateTemporal(defective)
    const r = temporalReport.value
    statusText.value = `已注入 4 类时序缺陷：检出 ${r.issues.length} 处，健康分 ${r.score}/100（点下方问题行可跳到对应帧）`
  }

  /** 点击质检问题行：跳到出问题的帧 */
  function gotoIssueFrame(frame: number) {
    gotoFrame(frame)
  }

  return {
    isPlaying, playSpeed, propagateScope, propagateStrategy,
    pausePlay, play, togglePlay, onSpeedChange, gotoFrame, doInterpolate, toggleTrajectories,
    onScopeChange, onStrategyChange, doPropagate,
    runTemporalQA, runOcclusionDemo, toggleSelectedVisibility, runTemporalDemo, gotoIssueFrame,
  }
}
