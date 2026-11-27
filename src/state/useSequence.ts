/**
 * ============================================================
 * 多帧时序模块
 * ============================================================
 * 帧切换、逐帧回放、轨迹插值、4D 轨迹叠加、跨帧编辑传播、时序质检。
 *
 * P1 之后真值在 TrackStore，boxes 只是当前帧的物化视图：
 * 切帧 = 从真值物化，不再有"写回"这一步，也不会因为漏写回丢修改。
 * frames 仍作为质检/导出/轨迹叠加的镜像，由 refreshFrameBoxes 同步。
 */
import { ref } from 'vue'
import { cloneBoxes } from '../core/history'
import { extractTrajectories, type PropagateScope } from '../core/sequence/sequence'
import { evaluateTemporal, injectTemporalDefects } from '../core/sequence/temporalQA'
import {
  buildInsertFramesCommand,
  buildInterpolateCommand,
  buildMergeCommand,
  buildOcclusionMarkerCommand,
  buildPropagateCommand,
  buildSetLifecycleCommand,
  buildSplitCommand,
} from '../domain/ops/trackOps'
import { geometryAtFrame } from '../domain/ops/interpolate'
import { toGeometry } from '../domain/model/geometry'
import { strVal, type StudioCore } from './studioCore'

export function useSequence(core: StudioCore) {
  const {
    boxes,
    selectedId,
    selectedIds,
    cloud,
    frames,
    currentFrame,
    statusText,
    showTrajectories,
    temporalReport,
    origin,
    mutate,
    syncViewer,
    onReset,
    markDirty,
    frameNav,
    store,
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

  /**
   * 切换帧。
   *
   * P1 之后不再"把当前帧写回 frames 再读目标帧"：真值在 TrackStore 里，
   * frames 只是镜像。切帧 = 从真值物化目标帧，因此：
   *   - 不会因为漏写回而丢修改；
   *   - 历史是文档级的，切帧不再 resetHistory（旧实现的最大体验问题）。
   *
   * P0 之后目标帧的点云可能是懒加载的（`cloud.count === 0`）：
   * 此时先把点云清空再去解码，避免"上一帧的点 + 这一帧的框"这种更危险的错配。
   * 用令牌保证快速连点只认最后一次结果。
   */
  let cloudLoadToken = 0

  function gotoFrame(fi: number) {
    if (!frames.value.length) return
    const target = Math.max(0, Math.min(frames.value.length - 1, fi))
    if (target === currentFrame.value) return
    currentFrame.value = target
    boxes.value = core.materializeNow(target)
    selectedId.value = null
    origin.value = null

    const frame = frames.value[target]
    const token = ++cloudLoadToken

    if (frame.cloud.count > 0) {
      cloud.value = frame.cloud
      syncViewer()
      markDirty()
      statusText.value = `第 ${target + 1}/${frames.value.length} 帧 · ${boxes.value.length} 个框`
      return
    }

    cloud.value = null
    syncViewer()
    statusText.value = `第 ${target + 1}/${frames.value.length} 帧 · 正在解码点云…`
    void core
      .loadFrameCloud(target)
      .then((c) => {
        // 用户可能已经点到别的帧：迟到结果必须丢掉，否则画面与帧号不一致
        if (token !== cloudLoadToken || currentFrame.value !== target) return
        if (!c) {
          statusText.value = `第 ${target + 1} 帧点云未缓存，请重新导入源文件（标注未丢失）`
          return
        }
        cloud.value = c
        syncViewer()
        markDirty()
        statusText.value = `第 ${target + 1}/${frames.value.length} 帧 · ${boxes.value.length} 个框`
      })
      .catch((err) => {
        if (token !== cloudLoadToken) return
        statusText.value = `第 ${target + 1} 帧点云读取失败：${(err as Error).message}（可重新导入源文件）`
      })

    markDirty()
  }

  /** 顶部帧导航：前后一帧 */
  function prevFrame() {
    if (currentFrame.value > 0) gotoFrame(currentFrame.value - 1)
  }

  function nextFrame() {
    if (currentFrame.value < frames.value.length - 1) gotoFrame(currentFrame.value + 1)
  }

  /** 滑块 / 数字输入直接跳帧 */
  function setFrame(i: number) {
    if (!Number.isFinite(i)) return
    gotoFrame(Math.round(i))
  }

  /**
   * 跳到上 / 下一处有标注的帧。
   * 500 帧的序列里一帧帧翻是最耗时的动作，按"有没有框"跳能省掉大量空帧。
   */
  function jumpToBoxFrame(dir: 1 | -1) {
    if (!frames.value.length) return
    for (let i = currentFrame.value + dir; i >= 0 && i < frames.value.length; i += dir) {
      const count = core.frameBoxCount(i)
      if (count) {
        gotoFrame(i)
        statusText.value = `第 ${i + 1} 帧有 ${count} 个标注`
        return
      }
    }
    statusText.value = dir > 0 ? '后面没有带标注的帧了' : '前面没有带标注的帧了'
  }

  // 键盘快捷键（标注模块）通过这个桥切帧，避免两个模块互相 import
  frameNav.next = nextFrame
  frameNav.prev = prevFrame
  frameNav.jumpToBox = jumpToBoxFrame

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

  /**
   * 轨迹插值：按运动模型补全关键帧之间的帧，并**落盘成关键帧**。
   * 与旧实现的区别：一条命令覆盖全部轨迹，Ctrl+Z 一次整段回退。
   */
  function doInterpolate() {
    const s = store.value
    if (!s) {
      statusText.value = '请先加载至少两帧的数据'
      return
    }
    const { command, stats } = buildInterpolateCommand(s.tracks, s.document.range)
    if (!command) {
      statusText.value = '所有轨迹的中间帧都已完整，无需插值'
      return
    }
    s.exec(command)
    core.refreshFrameBoxes(command.meta.affects.frames)
    boxes.value = core.materializeNow()
    selectedId.value = null
    syncViewer()
    markDirty()
    const longNote = stats.longSpans ? `；${stats.longSpans} 段超过 15 帧，建议补一个关键帧再插值` : ''
    statusText.value = `轨迹插值完成：补出 ${stats.frames} 帧 / ${stats.tracks} 条轨迹${longNote}（Ctrl+Z 可整段回退）`
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
  function onScopeChange(e: Event) {
    propagateScope.value = strVal(e) as PropagateScope
  }
  function onStrategyChange(e: Event) {
    propagateStrategy.value = strVal(e) as 'replace' | 'offset'
  }

  /**
   * 把选中框的当前修改传播到其他帧的同一条轨迹。
   * 用 origin（选中时的快照）作为"编辑前"基准，算增量或整框替换，
   * 最终产出一条 batch 命令，撤销一次全退。
   */
  function doPropagate() {
    const s = store.value
    const id = selectedId.value
    if (!s || !frames.value.length || !id) {
      statusText.value = '跨帧传播需要先加载帧序列，并选中一个框'
      return
    }
    const track = s.getTrack(id)
    const edited = boxes.value.find((b) => b.id === id)
    if (!track || !edited || !origin.value) {
      statusText.value = '请先选中一个框再传播'
      return
    }
    const command = buildPropagateCommand(
      track,
      core.frameNumber(),
      toGeometry(origin.value),
      toGeometry(edited),
      propagateScope.value,
      propagateStrategy.value,
    )
    if (!command) {
      statusText.value = '没有可传播的目标帧（该轨迹在选中范围内没有其他关键帧）'
      return
    }
    s.exec(command)
    core.refreshFrameBoxes(command.meta.affects.frames)
    boxes.value = core.materializeNow()
    origin.value = cloneBoxes([edited])[0]
    syncViewer()
    markDirty()
    const scopeText = { all: '全部帧', forward: '后续帧', backward: '前序帧' }[propagateScope.value]
    const strategyText = propagateStrategy.value === 'replace' ? '整框替换' : '增量平移'
    statusText.value = `跨帧传播完成：${strategyText} → ${scopeText}，修改了 ${command.meta.affects.frames.length} 帧的目标 #${id}（Ctrl+Z 可回退）`
  }

  // ---- 4D 时序质检 ----
  /** 对当前帧序列做 4D 一致性检查 */
  function runTemporalQA() {
    if (frames.value.length < 2) {
      statusText.value = '时序质检需要至少 2 帧（先加载序列演示）'
      return
    }
    // 质检吃的是 frames 镜像：先从真值刷新，避免拿旧标注算分
    core.refreshFrameBoxes()
    temporalReport.value = evaluateTemporal(frames.value)
    const r = temporalReport.value
    statusText.value =
      r.issues.length === 0
        ? `时序质检通过：${r.trackCount} 条轨迹、${r.frameCount} 帧，未发现异常`
        : `时序质检发现 ${r.issues.length} 处问题（ID跳变 ${r.counts.id_switch} / 速度突变 ${r.counts.speed_jump} / 抖动 ${r.counts.jitter} / 断裂 ${r.counts.track_gap}），健康分 ${r.score}`
  }

  /** 演示"显式标记遮挡"：把有 track_gap 的目标在缺口帧标为 occluded，看健康分回升 */
  function runOcclusionDemo() {
    const s = store.value
    if (!s || frames.value.length < 2) {
      statusText.value = '请先加载序列演示（至少 2 帧）'
      return
    }
    pausePlay()
    core.refreshFrameBoxes()
    const before = evaluateTemporal(frames.value)
    const gap = before.issues.find((i) => i.type === 'track_gap')
    if (!gap) {
      statusText.value = '当前序列没有轨迹断裂，无需标记遮挡。可先点「演示缺陷注入」制造断裂'
      temporalReport.value = before
      return
    }
    const track = s.getTrack(gap.objId)
    const geometry = track ? geometryAtFrame(track, gap.frame) : null
    if (!track || !geometry) {
      statusText.value = `目标 #${gap.objId} 在第 ${gap.frame} 帧两侧缺少关键帧，无法推断位置`
      temporalReport.value = before
      return
    }
    // 正式做法：一条 setObservation/insertFrames 命令，可撤销、可导出
    s.exec(buildOcclusionMarkerCommand(track, gap.frame, geometry))
    core.refreshFrameBoxes([gap.frame])
    const after = evaluateTemporal(frames.value)
    temporalReport.value = after
    gotoFrame(gap.frame)
    statusText.value = `已把 ${gap.objId} 在第 ${gap.frame} 帧标记为遮挡：健康分 ${before.score} → ${after.score}，该处断裂不再误报（遮挡点 ${after.occludedPoints} 个）`
    syncViewer()
    markDirty()
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

  /** 注入时序缺陷并立即质检，用于演示四类问题（只作用于质检副本，不写真值） */
  function runTemporalDemo() {
    if (frames.value.length < 2) {
      statusText.value = '请先加载序列演示'
      return
    }
    pausePlay()
    core.refreshFrameBoxes()
    const defective = injectTemporalDefects(frames.value)
    temporalReport.value = evaluateTemporal(defective)
    const r = temporalReport.value
    statusText.value = `已注入 4 类时序缺陷（演示用，不写入真值）：检出 ${r.issues.length} 处，健康分 ${r.score}/100（点下方问题行可跳到对应帧）`
  }

  /** 点击质检问题行：跳到出问题的帧 */
  function gotoIssueFrame(frame: number) {
    gotoFrame(frame)
  }

  // ---- 轨迹级操作（时间线面板的入口）----

  /** 按 frame.index 跳帧（frames 数组下标可能与 index 不同） */
  function gotoFrameIndex(frame: number) {
    const i = frames.value.findIndex((f) => f.index === frame)
    if (i >= 0) gotoFrame(i)
  }

  /** 在某帧补一个关键帧：几何由相邻关键帧插值推断，然后落盘成人工关键帧 */
  function addKeyframeAt(trackId: string, frame: number) {
    const s = store.value
    const track = s?.getTrack(trackId)
    if (!s || !track) return
    if (track.keyframes.some((k) => k.frame === frame)) {
      statusText.value = `#${trackId} 第 ${frame} 帧已经是关键帧`
      return
    }
    const geometry = geometryAtFrame(track, frame)
    if (!geometry) {
      statusText.value = `第 ${frame} 帧在 #${trackId} 的跨度之外，无法推断位置`
      return
    }
    s.exec(
      buildInsertFramesCommand(
        trackId,
        [
          {
            frame,
            geometry,
            source: { kind: 'manual' },
          },
        ],
        `#${trackId} 第 ${frame} 帧新增关键帧`,
      ),
    )
    core.refreshFrameBoxes([frame])
    core.bumpDoc()
    if (core.frameNumber() === frame) boxes.value = core.materializeNow()
    syncViewer()
    markDirty()
    statusText.value = `#${trackId} 第 ${frame} 帧已设为关键帧（可拖动精修）`
  }

  /**
   * 改生命周期（时间线拖两端）。
   * 拖拽过程只在组件里预览，松手才提交一条命令 —— 中间每一步都进历史的话，
   * 一次拖拽会产生几十条撤销记录，Ctrl+Z 变成了"退格键"。
   */
  function setTrackLifecycle(trackId: string, first: number, last: number) {
    const s = store.value
    const track = s?.getTrack(trackId)
    if (!s || !track) return
    const command = buildSetLifecycleCommand(track, first, last, s.document.range)
    if (!command) return
    s.exec(command)
    core.refreshFrameBoxes(command.meta.affects.frames)
    core.bumpDoc()
    boxes.value = core.materializeNow()
    core.pruneSelection()
    syncViewer()
    markDirty()
    statusText.value = `#${trackId} 生命周期已改为 ${first}–${last} 帧`
  }

  /** 拆分选中轨迹：frame 及之后归新 id（换车/再进入场景的串 ID 修复） */
  function splitSelectedAt(frame: number) {
    const s = store.value
    const id = selectedId.value
    const track = id ? s?.getTrack(id) : null
    if (!s || !track) {
      statusText.value = '先选中一条轨迹再拆分'
      return
    }
    const command = buildSplitCommand(track, frame, s.nextTrackId())
    if (!command) {
      statusText.value = '拆分点两侧都需要有关键帧，换一帧再试'
      return
    }
    s.exec(command)
    core.refreshFrameBoxes(command.meta.affects.frames)
    core.bumpDoc()
    boxes.value = core.materializeNow()
    core.pruneSelection()
    syncViewer()
    markDirty()
    statusText.value = `已拆分 #${track.id} → #${track.id} + 新轨迹（第 ${frame} 帧起）`
  }

  /** 合并选中的多条轨迹：第一条为 keep，其余被吸收 */
  function mergeSelectedTracks() {
    const s = store.value
    const ids = [...selectedIds.value]
    if (!s || ids.length < 2) {
      statusText.value = '按住 Ctrl 选中至少两条轨迹再合并'
      return
    }
    const keep = s.getTrack(ids[0])
    const absorbed = ids
      .slice(1)
      .map((id) => s.getTrack(id))
      .filter((t): t is NonNullable<typeof t> => !!t)
    const command = keep ? buildMergeCommand(keep, absorbed) : null
    if (!command) {
      statusText.value = '没有可合并的轨迹'
      return
    }
    s.exec(command)
    core.refreshFrameBoxes(command.meta.affects.frames)
    core.bumpDoc()
    boxes.value = core.materializeNow()
    core.pruneSelection()
    selectedId.value = keep!.id
    core.selectMany([keep!.id])
    syncViewer()
    markDirty()
    statusText.value = `已合并 ${ids.length} 条轨迹为 #${keep!.id}（同帧冲突保留 #${keep!.id} 的几何）`
  }

  return {
    isPlaying,
    playSpeed,
    propagateScope,
    propagateStrategy,
    pausePlay,
    play,
    togglePlay,
    onSpeedChange,
    gotoFrame,
    prevFrame,
    nextFrame,
    setFrame,
    jumpToBoxFrame,
    doInterpolate,
    toggleTrajectories,
    onScopeChange,
    onStrategyChange,
    doPropagate,
    runTemporalQA,
    runOcclusionDemo,
    toggleSelectedVisibility,
    runTemporalDemo,
    gotoIssueFrame,
    gotoFrameIndex,
    addKeyframeAt,
    splitSelectedAt,
    mergeSelectedTracks,
    setTrackLifecycle,
  }
}
