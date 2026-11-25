/**
 * ============================================================
 * 标注模块
 * ============================================================
 * 画框、框选中、属性编辑、撤销重做、复制粘贴、标注导入导出、键盘快捷键。
 *
 * 交互形态对齐 CVAT：
 *   - Top 视图拖拽 = 画框（由 OrthoView 发事件，这里只负责建数据）
 *   - 拖角点 / 旋转柄 / 高度柄 = 连续编辑，全部走 mutate(mergeKey) 合成一次撤销
 *   - 3D 视口单击 = 射线拾取选中
 */
import { ref } from 'vue'
import { isExportableView } from '../domain/ops/review'
import { cloneBoxes } from '../core/history'
import { parseSequence, serializeLabels, serializeSequence, downloadJson, downloadBlob } from '../core/io/label'
import { sequenceBlob } from '../adapters/sequenceExport'
import { smoothDocument } from '../domain/ops/smooth'
import { parseLabelsAuto } from '../core/io/formats'
import { fitBoxToPoints, estimateYawByPCA, pointInBoxBev } from '../core/geometry/box'
import { DEFAULT_CATEGORIES, type Box3D } from '../core/types'
import { toGeometry } from '../domain/model/geometry'
import { buildCopyToFramesBatchCommand } from '../domain/ops/trackOps'
import type { StudioCore } from './studioCore'

export interface DrawRect {
  cx: number
  cy: number
  length: number
  width: number
}

/** 跨帧复制的目标范围：下一帧 / 后续全部 / 全部其他帧 */
export type CopyScope = 'next' | 'forward' | 'all'

export function useAnnotation(core: StudioCore) {
  const {
    boxes, selectedId, selectedIds, selectedBoxes, selectedCount,
    cloud, statusText, origin, mutate, syncViewer, resetHistory,
    frames, currentFrame, categories, categoryOf, nextBoxId, markDirty,
    selectMany, toggleSelect, selectAll, pruneSelection,
  } = core

  const currentCategory = ref('Car')
  const labelInput = ref<HTMLInputElement | null>(null)

  /** 内部剪贴板：支持多选，跨帧粘贴时保留 label 与尺寸，只换 id */
  let clipboard: Box3D[] = []

  function nextId(): string {
    return nextBoxId()
  }

  /** Top 视图拖出的矩形 → 带默认高度的 3D 框 */
  function createBoxFromRect(rect: DrawRect) {
    const cat = categoryOf(currentCategory.value) ?? DEFAULT_CATEGORIES[0]
    const height = cat.defaultSize[2]
    const box: Box3D = {
      id: nextId(),
      label: cat.name,
      position: { x: rect.cx, y: rect.cy, z: height / 2 },
      scale: { x: Math.max(0.3, rect.length), y: Math.max(0.3, rect.width), z: height },
      yaw: 0,
    }
    const applied = mutate('新建框', () => {
      boxes.value.push(box)
      selectedId.value = box.id
      origin.value = cloneBoxes([box])[0]
    })
    core.tool.value = 'select'
    // 只读形态下 mutate 不会执行：状态栏已被它写成"只读"原因，这里不能再报"已新建"
    if (!applied) return
    statusText.value = `新建 ${box.label} #${box.id}：在 Side 视图拖绿点调高度，或在属性面板精调`
  }

  /** 用点云自动拟合（保留原能力：选中一片点云矩形后按 F 拟合） */
  function createBoxFromPoints(rect: { x0: number; y0: number; x1: number; y1: number }) {
    if (!cloud.value) return
    const pos = cloud.value.positions
    const indices: number[] = []
    for (let i = 0; i < cloud.value.count; i++) {
      const px = pos[i * 3], py = pos[i * 3 + 1]
      if (px >= rect.x0 && px <= rect.x1 && py >= rect.y0 && py <= rect.y1) indices.push(i)
    }
    if (indices.length < 5) {
      statusText.value = '框选区域内点数太少，无法拟合'
      return
    }
    const yaw = estimateYawByPCA(pos, indices)
    const fitted = fitBoxToPoints(pos, indices, yaw)
    const cat = categoryOf(currentCategory.value) ?? DEFAULT_CATEGORIES[0]
    const box: Box3D = {
      id: nextId(),
      label: cat.name,
      position: fitted?.position ?? { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2, z: cat.defaultSize[2] / 2 },
      scale: fitted?.scale ?? { x: rect.x1 - rect.x0, y: rect.y1 - rect.y0, z: cat.defaultSize[2] },
      yaw: fitted?.yaw ?? 0,
    }
    const applied = mutate('拟合新建框', () => {
      boxes.value.push(box)
      selectedId.value = box.id
      origin.value = cloneBoxes([box])[0]
    })
    if (!applied) return
    statusText.value = `新建框 ${box.label} #${box.id}（用 ${indices.length} 个点自动拟合）`
  }

  /** 选中框时记录"编辑前"快照，供跨帧传播计算增量 */
  function rememberOrigin() {
    const b = core.selectedBox.value
    origin.value = b ? cloneBoxes([b])[0] : null
  }

  function selectBox(id: string | null) {
    selectedId.value = id // 可写 computed：赋值即收敛为单选
    rememberOrigin()
    syncViewer()
    const b = core.selectedBox.value
    if (b) statusText.value = `选中 ${b.label} #${b.id}`
    else statusText.value = '未选中对象'
  }

  /** Ctrl / Cmd 点选：在选中集合里增删一个 */
  function toggleSelectBox(id: string) {
    toggleSelect(id)
    rememberOrigin()
    syncViewer()
    statusText.value = selectedCount.value > 1
      ? `已选 ${selectedCount.value} 个对象`
      : `选中 #${id}`
  }

  /** 橡皮筋框选：一次选中一批 */
  function selectGroup(ids: string[]) {
    if (!ids.length) return
    selectMany(ids)
    rememberOrigin()
    syncViewer()
    statusText.value = ids.length > 1 ? `框选 ${ids.length} 个对象` : `选中 #${ids[0]}`
  }

  function selectAllBoxes() {
    selectAll()
    rememberOrigin()
    syncViewer()
    statusText.value = `已全选 ${selectedCount.value} 个对象`
  }

  /** 3D 视口点击拾取；带 Ctrl / Shift 时是追加 */
  function onViewerClick(e: MouseEvent) {
    const viewer = core.getViewer()
    if (!viewer || e.button !== 0) return
    const id = viewer.pickBox(e.clientX, e.clientY, core.visibleBoxes.value)
    if (!id) { selectBox(null); return }
    if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelectBox(id)
    else selectBox(id)
  }

  /**
   * 正交视图拖拽提交：用整框替换 + mergeKey 合并连续事件。
   * 锁定的对象不可编辑（对齐 CVAT 的 lock 语义）。
   */
  function applyBox(id: string, next: Box3D, mergeKey: string) {
    if (core.isLocked(id)) return
    mutate('拖拽编辑', () => {
      const cur = boxes.value.find((b) => b.id === id)
      if (!cur) return
      cur.position = { ...next.position }
      cur.scale = { ...next.scale }
      cur.yaw = next.yaw
      cur.label = next.label
      if (next.visibility) cur.visibility = next.visibility
    }, mergeKey)
  }

  /**
   * 多选整体拖动：一次 mutate 写完，mergeKey 让整段拖拽只合成一步撤销。
   * 锁定的成员直接跳过（对齐 CVAT：锁住的对象不参与任何编辑）。
   */
  function applyBoxes(list: Box3D[], mergeKey: string, label = '拖动多个框') {
    mutate(label, () => {
      for (const next of list) {
        if (core.isLocked(next.id)) continue
        const cur = boxes.value.find((b) => b.id === next.id)
        if (!cur) continue
        cur.position = { ...next.position }
        cur.scale = { ...next.scale }
        cur.yaw = next.yaw
      }
    }, mergeKey)
  }

  /** 数字键 / 类别下拉：改所有选中对象的类别；没有选中时只改"下一个新框"的默认类别 */
  function relabelSelected(label: string) {
    const targets = selectedBoxes.value.filter((b) => !core.isLocked(b.id))
    if (!targets.length) {
      currentCategory.value = label
      statusText.value = `当前类别：${label}`
      return
    }
    mutate('修改类别', () => {
      for (const b of targets) b.label = label
    })
    currentCategory.value = label
    statusText.value = targets.length > 1
      ? `已把 ${targets.length} 个对象改为 ${label}`
      : `#${targets[0].id} 改为 ${label}`
  }

  /**
   * 用框内的点云重新拟合选中框（PCA 主方向 + 局部 min/max）。
   * 这是 CVAT 改造时丢掉的能力：`createBoxFromPoints` 至今没有调用点，
   * 所以改由「选中已有框 → Shift+F」触发，语义更直接。
   */
  function refitSelected() {
    const targets = selectedBoxes.value.filter((b) => !core.isLocked(b.id))
    if (!targets.length) {
      statusText.value = '先选中要拟合的框'
      return
    }
    const cv = cloud.value
    if (!cv) return
    const pos = cv.positions
    const next: Box3D[] = []
    let fittedCount = 0
    for (const b of targets) {
      const idx: number[] = []
      for (let i = 0; i < cv.count; i++) {
        if (pointInBoxBev(b, pos[i * 3], pos[i * 3 + 1])) idx.push(i)
      }
      const nb = cloneBoxes([b])[0]
      if (idx.length >= 5) {
        const fitted = fitBoxToPoints(pos, idx, estimateYawByPCA(pos, idx))
        if (fitted) {
          nb.position = fitted.position
          nb.scale = fitted.scale
          nb.yaw = fitted.yaw
          fittedCount++
        }
      }
      next.push(nb)
    }
    if (!fittedCount) {
      statusText.value = '框内点太少，无法拟合（至少需要 5 个点）'
      return
    }
    applyBoxes(next, `fit:${targets.map((b) => b.id).join(',')}`, '自动拟合')
    statusText.value = `已用点云重新拟合 ${fittedCount} 个对象`
  }

  function setBoxProp(prop: string, value: number | string) {
    const id = selectedId.value
    if (!id || core.isLocked(id)) return
    if (typeof value === 'number' && !Number.isFinite(value)) return
    mutate('修改属性', () => {
      const b = boxes.value.find((x) => x.id === id)
      if (!b) return
      switch (prop) {
        case 'label': b.label = value as string; break
        case 'x': b.position.x = value as number; break
        case 'y': b.position.y = value as number; break
        case 'z': b.position.z = value as number; break
        case 'length': b.scale.x = Math.max(0.1, value as number); break
        case 'width': b.scale.y = Math.max(0.1, value as number); break
        case 'height': b.scale.z = Math.max(0.1, value as number); break
        case 'yaw': b.yaw = value as number; break
      }
    }, `prop:${id}:${prop}`)
  }

  /** 克隆选中的一批框，并把 id 换成新的、整体偏移 2m（避免与原框完全重叠） */
  function cloneAsNew(src: Box3D[]): Box3D[] {
    return src.map((b) => ({
      ...cloneBoxes([b])[0],
      id: nextId(),
      position: { ...b.position, x: b.position.x + 2, y: b.position.y + 2 },
    }))
  }

  function adoptSelection(ids: string[]) {
    selectMany(ids)
    rememberOrigin()
    syncViewer()
  }

  function duplicateSelected() {
    const src = selectedBoxes.value
    if (!src.length) return
    const copies = cloneAsNew(src)
    if (!mutate('复制框', () => {
      boxes.value.push(...copies)
    })) return
    adoptSelection(copies.map((c) => c.id))
    statusText.value = copies.length > 1 ? `已复制 ${copies.length} 个对象` : `已复制为 #${copies[0].id}`
  }

  function copySelected() {
    const src = selectedBoxes.value
    if (!src.length) return
    clipboard = cloneBoxes(src)
    statusText.value = src.length > 1
      ? `已复制 ${src.length} 个对象，Ctrl+V 粘贴到当前帧`
      : `已复制 #${src[0].id}，Ctrl+V 粘贴到当前帧`
  }

  function pasteClipboard() {
    if (!clipboard.length) return
    const copies = cloneAsNew(clipboard)
    if (!mutate('粘贴框', () => {
      boxes.value.push(...copies)
    })) return
    adoptSelection(copies.map((c) => c.id))
    statusText.value = copies.length > 1 ? `已粘贴 ${copies.length} 个对象` : `已粘贴为 #${copies[0].id}`
  }

  /**
   * 把当前帧选中的框复制到其他帧，**保持 id 不变**——同 id 跨帧就是同一条轨迹。
   * 这是 CVAT 里「一次画好、往后铺」的做法：先标好一帧，再逐帧微调。
   * 目标帧已有同 id 的框就跳过，不覆盖已经手工调过的标注。
   */
  function copyToFrames(scope: CopyScope) {
    const s = core.store.value
    if (!frames.value.length || !s) {
      statusText.value = '跨帧复制需要先加载多帧序列'
      return
    }
    const src = selectedBoxes.value
    if (!src.length) {
      statusText.value = '先选中要复制的框'
      return
    }
    const from = currentFrame.value
    const targets: number[] = []
    for (let i = 0; i < frames.value.length; i++) {
      if (i === from) continue
      if (scope === 'next' && i !== from + 1) continue
      if (scope === 'forward' && i <= from) continue
      targets.push(frames.value[i].index)
    }
    if (!targets.length) {
      statusText.value = scope === 'next' ? '当前已经是最后一帧' : '没有可复制的目标帧'
      return
    }

    // 目标帧已有该轨迹的关键帧就跳过，不覆盖已经手工调过的标注
    let skipped = 0
    const items: Array<{ trackId: string; frames: number[]; geometry: ReturnType<typeof toGeometry> }> = []
    for (const b of src) {
      const track = s.getTrack(b.id)
      if (!track) continue
      const have = new Set(track.keyframes.map((k) => k.frame))
      const missing = targets.filter((f) => !have.has(f))
      skipped += targets.length - missing.length
      if (missing.length) items.push({ trackId: b.id, frames: missing, geometry: toGeometry(b) })
    }

    const command = buildCopyToFramesBatchCommand(items, `复制 ${src.length} 个对象到其他帧`)
    const scopeText = scope === 'next' ? '下一帧' : scope === 'forward' ? '后续帧' : '全部帧'
    if (!command) {
      statusText.value = `${scopeText}里都已经有这些对象（跳过 ${skipped} 个），未新增`
      return
    }
    s.exec(command)
    core.refreshFrameBoxes(command.meta.affects.frames)
    markDirty()
    syncViewer()
    const added = command.meta.affects.frames.length
    statusText.value = `已把 ${src.length} 个对象复制到${scopeText}：新增 ${added} 帧${skipped ? `，跳过 ${skipped} 处已存在` : ''}（Ctrl+Z 可回退）`
  }

  /** 删除所有选中；锁定的自动跳过，并明确告诉用户跳过了几个 */
  function deleteSelected() {
    const ids = [...selectedIds.value].filter((id) => !core.isLocked(id))
    if (!ids.length) {
      if (selectedCount.value) statusText.value = '选中的对象都已锁定，先解锁再删除'
      return
    }
    const skipped = selectedCount.value - ids.length
    if (!mutate(ids.length > 1 ? `删除 ${ids.length} 个框` : '删除框', () => {
      boxes.value = boxes.value.filter((b) => !ids.includes(b.id))
      selectedId.value = null
    })) return
    statusText.value = ids.length > 1
      ? `已删除 ${ids.length} 个对象${skipped ? `（跳过 ${skipped} 个锁定）` : ''}`
      : `已删除 #${ids[0]}`
  }

  // ---- 撤销重做 ----
  function doUndo() {
    const step = core.undoState()
    if (!step) return
    boxes.value = step.state
    pruneSelection()
    core.syncHistoryUi()
    syncViewer()
    markDirty()
    statusText.value = `已撤销：${step.label}`
  }

  function doRedo() {
    const step = core.redoState()
    if (!step) return
    boxes.value = step.state
    pruneSelection()
    core.syncHistoryUi()
    syncViewer()
    markDirty()
    statusText.value = `已重做：${step.label}`
  }

  // ---- 导入导出 ----
  function baseName(): string {
    const raw = core.datasetName.value || 'labels'
    return raw.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_')
  }

  /** 只导当前帧：保持 SUSTechPOINTS 兼容（单帧数组） */
  function doExportFrame() {
    const suffix = frames.value.length ? `-${String(currentFrame.value + 1).padStart(4, '0')}` : ''
    // 导出闸门：模型给的、还没被接受的框不进训练数据（人工框不受影响）
    const list = boxes.value.filter((b) => isExportableView(b as Box3D & { review?: string; sourceKind?: string }))
    downloadJson(`${baseName()}${suffix}.json`, serializeLabels(list))
    const dropped = boxes.value.length - list.length
    statusText.value = `已导出当前帧 ${list.length} 个框（SUSTechPOINTS 格式）`
      + (dropped ? `，${dropped} 个待复核/已拒绝的模型框未导出` : '')
  }

  /**
   * 导出整段序列。
   * 关键：boxes 只是当前帧的工作副本，导出前必须先写回 frames，否则少一帧。
   */
  function doExportAll() {
    if (!frames.value.length) {
      doExportFrame()
      return
    }
    // 导出吃 frames 镜像：先从真值全量刷新，避免少帧或旧框
    core.refreshFrameBoxes()
    const payload = frames.value.map((f) => ({
      index: f.index,
      boxes: f.boxes.filter((b) => isExportableView(b as Box3D & { review?: string; sourceKind?: string })),
    }))
    downloadJson(`${baseName()}-sequence.json`, serializeSequence(payload))
    const total = payload.reduce((n, f) => n + f.boxes.length, 0)
    const dropped = frames.value.reduce((n, f) => n + f.boxes.length, 0) - total
    statusText.value = `已导出 ${frames.value.length} 帧 / ${total} 个框的整段序列`
      + (dropped ? `（${dropped} 个待复核/已拒绝的模型框未导出）` : '')
  }

  /**
   * 导出整段序列（真值 + 插值补帧）。
   *
   * 与 `doExportAll` 的区别值得说清楚，两者不是替代关系：
   *   doExportAll    吃 frames 镜像 —— 只有翻到过的帧，内容与屏幕一致；
   *   doExportSeq    吃 TrackStore.materializeAll —— 按 document.range 全范围补帧，
   *                  中间帧用线性插值算出来，是"给训练用的连续轨迹"。
   * 后者是流式的：引擎不会为了导出 500 帧而先生成 10 万个对象数组。
   */
  function doExportSeq() {
    const store = core.store.value
    if (!store) {
      statusText.value = '还没有可导出的文档'
      return
    }
    const [from, to] = store.document.range
    const frames = Math.max(0, to - from + 1)
    downloadBlob(`${baseName()}-sequence-interp.json`, sequenceBlob(store, {
      materialize: { mode: 'linear', acceptedOnly: true },
    }))
    statusText.value = `已导出第 ${from}–${to} 帧（共 ${frames} 帧，插值补帧）· ${store.trackCount} 条轨迹`
  }

  /**
   * 导出整段（RTS 平滑）。
   *
   * 关键帧位置一律不动（人工确认过的框不该被算法挪），只把中间帧的抖动修平。
   * 抖动过大（> 0.3m）的轨迹整条放弃并在状态栏点名 —— 那种情况该去修标注，
   * 而不是接受一条"看起来顺、位置错"的轨迹。
   */
  function doExportSmooth() {
    const store = core.store.value
    if (!store) {
      statusText.value = '还没有可导出的文档'
      return
    }
    const [from, to] = store.document.range
    const { paths, skipped } = smoothDocument(store.document)
    downloadBlob(`${baseName()}-sequence-smooth.json`, sequenceBlob(store, {
      materialize: { mode: 'linear', paths, acceptedOnly: true },
    }))
    const jittery = skipped.filter((s) => s.reason === 'shift-too-large')
    const tail = jittery.length
      ? `；${jittery.length} 条抖动过大未平滑（最大 ${jittery[0].maxShift.toFixed(2)}m）`
      : ''
    statusText.value = `已导出第 ${from}–${to} 帧（RTS 平滑 ${paths.size}/${store.trackCount} 条轨迹${tail}）`
  }

  /** 导入标注：单帧数组直接覆盖；本工具的序列文件按帧号合并 */
  async function onLabelFile(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    try {
      const text = await file.text()
      if (text.includes('pcl-label-studio/sequence')) {
        const parsed = parseSequence(text)
        if (frames.value.length) {
          for (const f of parsed) {
            const target = frames.value.find((x) => x.index === f.index)
            if (target) target.boxes = f.boxes
          }
          boxes.value = cloneBoxes(frames.value[currentFrame.value].boxes)
          statusText.value = `已按帧号合并 ${parsed.length} 帧标注`
        } else {
          boxes.value = parsed[0]?.boxes ?? []
          statusText.value = `当前是单帧数据集，只导入第 1 帧（共 ${parsed.length} 帧）`
        }
      } else {
        // 自动识别 SUSTech / KITTI / DAIR-V2X / nuScenes / Waymo
        const result = parseLabelsAuto(text, file.name)
        boxes.value = result.boxes
        const skipNote = result.skipped.length
          ? ` · 跳过 ${result.skipped.map((s) => `${s.reason}×${s.count}`).join('、')}`
          : ''
        statusText.value = `已识别 ${result.formatLabel} · 导入 ${result.boxes.length} 个框${skipNote}`
      }
      core.ensureCategories(boxes.value)
      selectedId.value = null
      // 导入的是 v1 结构（整帧框），重建文档后才进入 4D 真值
      core.rebuildDocument()
      resetHistory()
      syncViewer()
      markDirty()
    } catch (err) {
      statusText.value = `导入失败：${(err as Error).message}`
    }
  }

  // ---- 键盘快捷键：编辑选中的框 ----
  /** 方向键微调：多选时整组一起动，锁定成员跳过 */
  function nudge(dx: number, dy: number, dz: number, step: number) {
    const targets = selectedBoxes.value.filter((b) => !core.isLocked(b.id))
    if (!targets.length) return
    const next = cloneBoxes(targets)
    for (const b of next) {
      b.position.x += dx * step
      b.position.y += dy * step
      b.position.z += dz * step
    }
    applyBoxes(next, `nudge:${targets.map((b) => b.id).join(',')}`, '微调位置')
    statusText.value = `微调 ${targets.length} 个对象（步长 ${step} m）`
  }

  /** Tab / Shift+Tab 在对象之间前后切换（CVAT 同款） */
  function cycleSelection(dir: 1 | -1) {
    const list = core.visibleBoxes.value
    if (!list.length) return
    const at = list.findIndex((b) => b.id === selectedId.value)
    const i = at < 0
      ? (dir > 0 ? 0 : list.length - 1)
      : (at + dir + list.length) % list.length
    selectBox(list[i].id)
    statusText.value = `选中 ${list[i].label} #${list[i].id}`
  }

  function onKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    const key = e.key.toLowerCase()
    const ctrl = e.ctrlKey || e.metaKey

    if (ctrl && key === 's') {
      e.preventDefault()
      if (e.shiftKey) doExportAll(); else doExportFrame()
      return
    }
    if (ctrl && key === 'z') {
      e.preventDefault()
      if (e.shiftKey) doRedo(); else doUndo()
      return
    }
    if (ctrl && key === 'y') { e.preventDefault(); doRedo(); return }
    if (ctrl && key === 'a') { e.preventDefault(); selectAllBoxes(); return }
    if (ctrl && key === 'c') { e.preventDefault(); copySelected(); return }
    if (ctrl && key === 'v') { e.preventDefault(); pasteClipboard(); return }
    if (ctrl && key === 'd') { e.preventDefault(); duplicateSelected(); return }
    // Ctrl+B：把选中框广播到后续所有帧（同 id，构成轨迹）
    if (ctrl && key === 'b') { e.preventDefault(); copyToFrames('forward'); return }

    // 工具切换：V 选择 / H 平移 / N 画框（与 CVAT 一致）
    if (!ctrl && !e.altKey) {
      if (key === 'v') { core.tool.value = 'select'; statusText.value = '工具：选择'; return }
      if (key === 'h') { core.tool.value = 'pan'; statusText.value = '工具：平移'; return }
      if (key === 'n') {
        core.tool.value = 'draw'
        core.orthoMax.value = 'top' // 与 CVAT 一致：画框时把顶视放到最大
        statusText.value = '工具：画框（在 Top 视图拖拽）'
        return
      }
      if (key === 'escape') {
        selectBox(null)
        core.tool.value = 'select'
        return
      }
      // , / . 切帧；按住 Shift 直接跳到上一处 / 下一处有标注的帧。
      // 用 e.code 而不是 e.key：Shift+. 的 key 是 '>'，按字符判断会漏掉
      if (e.code === 'Comma' || e.code === 'Period') {
        e.preventDefault()
        const dir = e.code === 'Period' ? 1 : -1
        if (e.shiftKey) core.frameNav.jumpToBox?.(dir)
        else if (dir > 0) core.frameNav.next?.()
        else core.frameNav.prev?.()
        return
      }
      // 数字键 1-9：有选中就改选中对象的类别，没选中只改「下一个新框」的默认类别
      if (/^[1-9]$/.test(key)) {
        const cat = categories.value[Number(key) - 1]
        if (cat) { relabelSelected(cat.name); return }
      }
    }

    // 方向键 / Tab：不依赖"有选中"，先处理
    if (!ctrl && !e.altKey) {
      const step = e.shiftKey ? 0.5 : 0.1
      if (key === 'arrowleft') { e.preventDefault(); nudge(-1, 0, 0, step); return }
      if (key === 'arrowright') { e.preventDefault(); nudge(1, 0, 0, step); return }
      if (key === 'arrowup') { e.preventDefault(); nudge(0, 1, 0, step); return }
      if (key === 'arrowdown') { e.preventDefault(); nudge(0, -1, 0, step); return }
      if (key === 'pageup') { e.preventDefault(); nudge(0, 0, 1, step); return }
      if (key === 'pagedown') { e.preventDefault(); nudge(0, 0, -1, step); return }
      if (key === 'tab') { e.preventDefault(); cycleSelection(e.shiftKey ? -1 : 1); return }
    }

    const targets = selectedBoxes.value.filter((b) => !core.isLocked(b.id))
    if (!targets.length) {
      if (selectedCount.value) statusText.value = '选中的对象都已锁定，先解锁再编辑'
      return
    }
    const step = e.shiftKey ? 0.5 : 0.1
    const gk = (s: string) => `k:${targets.map((b) => b.id).join(',')}:${s}`
    // Shift+F：用框内点云重新拟合（F 单独按下仍是缩短长度）
    if (key === 'f' && e.shiftKey) {
      e.preventDefault()
      refitSelected()
      return
    }
    /** 对整组做同一个变换：改快照再整组提交 */
    const edit = (label: string, fn: (b: Box3D) => void, suffix: string) => {
      const next = cloneBoxes(targets)
      next.forEach(fn)
      applyBoxes(next, gk(suffix), label)
    }

    switch (key) {
      case 'w': edit('平移框', (b) => { b.position.x += step }, 'x+'); break
      case 's': edit('平移框', (b) => { b.position.x -= step }, 'x-'); break
      case 'a': edit('平移框', (b) => { b.position.y += step }, 'y+'); break
      case 'd': edit('平移框', (b) => { b.position.y -= step }, 'y-'); break
      case 'q': edit('旋转框', (b) => { b.yaw += 0.05 }, 'yaw+'); break
      case 'e': edit('旋转框', (b) => { b.yaw -= 0.05 }, 'yaw-'); break
      case 'r': edit('缩放框', (b) => { b.scale.x = Math.max(0.2, b.scale.x + step) }, 'len+'); break
      case 'f': edit('缩放框', (b) => { b.scale.x = Math.max(0.2, b.scale.x - step) }, 'len-'); break
      case 'delete':
      case 'backspace':
        deleteSelected()
        break
      default: return
    }
    e.preventDefault()
  }

  /** 选中框在点云里的投影，仅用于判断点选（保留原有能力） */
  function pickAt(x: number, y: number): Box3D | null {
    return [...boxes.value].reverse().find((b) => pointInBoxBev(b, x, y)) ?? null
  }

  return {
    currentCategory, labelInput, createBoxFromRect, createBoxFromPoints, selectBox, onViewerClick,
    toggleSelectBox, selectGroup, selectAllBoxes, relabelSelected, refitSelected,
    applyBox, applyBoxes, setBoxProp, duplicateSelected, copySelected, pasteClipboard, deleteSelected,
    copyToFrames,
    doUndo, doRedo, doExportFrame, doExportAll, doExportSeq, doExportSmooth, onLabelFile, onKeyDown, pickAt,
  }
}
