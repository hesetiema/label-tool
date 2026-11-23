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
import { cloneBoxes } from '../core/history'
import { parseLabels, parseSequence, serializeLabels, serializeSequence, downloadJson } from '../core/io/label'
import { fitBoxToPoints, estimateYawByPCA, pointInBoxBev } from '../core/geometry/box'
import { DEFAULT_CATEGORIES, type Box3D } from '../core/types'
import type { StudioCore } from './studioCore'

export interface DrawRect {
  cx: number
  cy: number
  length: number
  width: number
}

export function useAnnotation(core: StudioCore) {
  const {
    boxes, selectedId, cloud, statusText, origin, mutate, syncViewer, resetHistory,
    frames, currentFrame, categories, categoryOf, nextBoxId, markDirty,
  } = core

  const currentCategory = ref('Car')
  const labelInput = ref<HTMLInputElement | null>(null)

  /** 内部剪贴板：跨帧粘贴同一目标时保留 label 与尺寸，只换 id */
  let clipboard: Box3D | null = null

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
    mutate('新建框', () => {
      boxes.value.push(box)
      selectedId.value = box.id
      origin.value = cloneBoxes([box])[0]
    })
    core.tool.value = 'select'
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
    mutate('拟合新建框', () => {
      boxes.value.push(box)
      selectedId.value = box.id
      origin.value = cloneBoxes([box])[0]
    })
    statusText.value = `新建框 ${box.label} #${box.id}（用 ${indices.length} 个点自动拟合）`
  }

  /** 选中框时记录"编辑前"快照，供跨帧传播计算增量 */
  function selectBox(id: string | null) {
    selectedId.value = id
    const b = id ? boxes.value.find((x) => x.id === id) : null
    origin.value = b ? cloneBoxes([b])[0] : null
    syncViewer()
  }

  /** 3D 视口点击拾取 */
  function onViewerClick(e: MouseEvent) {
    const viewer = core.getViewer()
    if (!viewer || e.button !== 0) return
    const id = viewer.pickBox(e.clientX, e.clientY, core.visibleBoxes.value)
    selectBox(id)
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

  function duplicateSelected() {
    const b = core.selectedBox.value
    if (!b) return
    const copy: Box3D = {
      ...cloneBoxes([b])[0],
      id: nextId(),
      position: { ...b.position, x: b.position.x + 2, y: b.position.y + 2 },
    }
    mutate('复制框', () => {
      boxes.value.push(copy)
      selectedId.value = copy.id
      origin.value = cloneBoxes([copy])[0]
    })
    statusText.value = `已复制为 #${copy.id}`
  }

  function copySelected() {
    const b = core.selectedBox.value
    if (!b) return
    clipboard = cloneBoxes([b])[0]
    statusText.value = `已复制 #${b.id}，Ctrl+V 粘贴到当前帧`
  }

  function pasteClipboard() {
    if (!clipboard) return
    const copy: Box3D = {
      ...cloneBoxes([clipboard])[0],
      id: nextId(),
      position: { ...clipboard.position, x: clipboard.position.x + 2, y: clipboard.position.y + 2 },
    }
    mutate('粘贴框', () => {
      boxes.value.push(copy)
      selectedId.value = copy.id
      origin.value = cloneBoxes([copy])[0]
    })
    statusText.value = `已粘贴为 #${copy.id}`
  }

  function deleteSelected() {
    const id = selectedId.value
    if (!id || core.isLocked(id)) return
    mutate('删除框', () => {
      boxes.value = boxes.value.filter((b) => b.id !== id)
      selectedId.value = null
    })
  }

  // ---- 撤销重做 ----
  function doUndo() {
    const step = core.undoState()
    if (!step) return
    boxes.value = step.state
    if (selectedId.value && !boxes.value.some((b) => b.id === selectedId.value)) selectedId.value = null
    core.syncHistoryUi()
    syncViewer()
    markDirty()
    statusText.value = `已撤销：${step.label}`
  }

  function doRedo() {
    const step = core.redoState()
    if (!step) return
    boxes.value = step.state
    if (selectedId.value && !boxes.value.some((b) => b.id === selectedId.value)) selectedId.value = null
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
    downloadJson(`${baseName()}${suffix}.json`, serializeLabels(boxes.value))
    statusText.value = `已导出当前帧 ${boxes.value.length} 个框（SUSTechPOINTS 格式）`
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
    frames.value[currentFrame.value].boxes = cloneBoxes(boxes.value)
    const payload = frames.value.map((f) => ({ index: f.index, boxes: f.boxes }))
    downloadJson(`${baseName()}-sequence.json`, serializeSequence(payload))
    const total = frames.value.reduce((n, f) => n + f.boxes.length, 0)
    statusText.value = `已导出 ${frames.value.length} 帧 / ${total} 个框的整段序列`
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
        boxes.value = parseLabels(text)
        statusText.value = `已导入 ${boxes.value.length} 个标注框`
      }
      core.ensureCategories(boxes.value)
      selectedId.value = null
      resetHistory()
      syncViewer()
      markDirty()
    } catch (err) {
      statusText.value = `导入失败：${(err as Error).message}`
    }
  }

  // ---- 键盘快捷键：编辑选中的框 ----
  function onKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    const box = core.selectedBox.value
    const key = e.key.toLowerCase()

    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault()
      if (e.shiftKey) doExportAll(); else doExportFrame()
      return
    }
    if ((e.ctrlKey || e.metaKey) && key === 'z') {
      e.preventDefault()
      if (e.shiftKey) doRedo(); else doUndo()
      return
    }
    if ((e.ctrlKey || e.metaKey) && key === 'y') {
      e.preventDefault()
      doRedo()
      return
    }
    if ((e.ctrlKey || e.metaKey) && key === 'c') {
      e.preventDefault(); copySelected(); return
    }
    if ((e.ctrlKey || e.metaKey) && key === 'v') {
      e.preventDefault(); pasteClipboard(); return
    }
    if ((e.ctrlKey || e.metaKey) && key === 'd') {
      e.preventDefault(); duplicateSelected(); return
    }

    // 工具切换：V 选择 / H 平移 / N 画框（与 CVAT 一致）
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (key === 'v') { core.tool.value = 'select'; statusText.value = '工具：选择'; return }
      if (key === 'h') { core.tool.value = 'pan'; statusText.value = '工具：平移'; return }
      if (key === 'n') {
        core.tool.value = 'draw'
        core.orthoMax.value = 'top' // 与 CVAT 一致：画框时把顶视放到最大
        statusText.value = '工具：画框（在 Top 视图拖拽）'
        return
      }
      if (key === 'escape') { selectBox(null); core.tool.value = 'select'; return }
      // 数字键 1-9 快速切换当前类别（CVAT 同样用数字选 label）
      if (/^[1-9]$/.test(key)) {
        const cat = categories.value[Number(key) - 1]
        if (cat) {
          currentCategory.value = cat.name
          statusText.value = `当前类别：${cat.name}`
          return
        }
      }
    }

    if (!box) return
    if (core.isLocked(box.id)) {
      statusText.value = `#${box.id} 已锁定，先解锁再编辑`
      return
    }
    const step = e.shiftKey ? 0.5 : 0.1
    const mk = (suffix: string) => `k:${box.id}:${suffix}`
    switch (key) {
      case 'w': mutate('平移框', () => { box.position.x += step }, mk('x+')); break
      case 's': mutate('平移框', () => { box.position.x -= step }, mk('x-')); break
      case 'a': mutate('平移框', () => { box.position.y += step }, mk('y+')); break
      case 'd': mutate('平移框', () => { box.position.y -= step }, mk('y-')); break
      case 'q': mutate('旋转框', () => { box.yaw += 0.05 }, mk('yaw+')); break
      case 'e': mutate('旋转框', () => { box.yaw -= 0.05 }, mk('yaw-')); break
      case 'r': mutate('缩放框', () => { box.scale.x = Math.max(0.2, box.scale.x + step) }, mk('len+')); break
      case 'f': mutate('缩放框', () => { box.scale.x = Math.max(0.2, box.scale.x - step) }, mk('len-')); break
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
    applyBox, setBoxProp, duplicateSelected, copySelected, pasteClipboard, deleteSelected,
    doUndo, doRedo, doExportFrame, doExportAll, onLabelFile, onKeyDown, pickAt,
  }
}
