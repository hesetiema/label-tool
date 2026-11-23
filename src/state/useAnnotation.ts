/**
 * ============================================================
 * 标注模块
 * ============================================================
 * BEV 拖拽画框、框选中、属性编辑、撤销重做、标注文件导入导出、键盘快捷键。
 *
 * 这一块只碰"当前帧的 boxes"，不关心帧序列怎么切、相机怎么运镜，
 * 因此它只需要 studioCore，不需要知道其他模块的存在。
 */
import { ref } from 'vue'
import { cloneBoxes } from '../core/history'
import { parseLabels, serializeLabels, downloadJson } from '../core/io/label'
import { fitBoxToPoints, estimateYawByPCA, pointInBoxBev } from '../core/geometry/box'
import { DEFAULT_CATEGORIES, type Box3D } from '../core/types'
import type { StudioCore } from './studioCore'

export function useAnnotation(core: StudioCore) {
  const { boxes, selectedId, cloud, statusText, mode, origin, mutate, syncViewer, resetHistory } = core

  const currentCategory = ref('Car')
  const labelInput = ref<HTMLInputElement | null>(null)

  // ---- BEV 拖拽画框 ----
  let dragging = false
  let dragStart = { x: 0, y: 0 }
  let dragEnd = { x: 0, y: 0 }

  function onMouseDown(e: MouseEvent) {
    if (mode.value !== 'bev' || e.button !== 0) return
    const viewer = core.getViewer()
    if (!viewer) return
    const p = viewer.screenToBev(e.clientX, e.clientY)
    dragStart = p
    dragEnd = p
    dragging = true
  }

  function onMouseMove(e: MouseEvent) {
    if (!dragging || mode.value !== 'bev') return
    const viewer = core.getViewer()
    if (!viewer) return
    dragEnd = viewer.screenToBev(e.clientX, e.clientY)
    viewer.showDraft(dragStart, dragEnd)
  }

  function onMouseUp(_e: MouseEvent) {
    if (!dragging) return
    dragging = false
    const viewer = core.getViewer()
    if (!viewer) return
    viewer.clearDraft()
    const dx = Math.abs(dragEnd.x - dragStart.x)
    const dy = Math.abs(dragEnd.y - dragStart.y)

    // 拖拽距离很小 → 视为点击选中
    if (dx < 0.4 && dy < 0.4) {
      const hit = [...boxes.value].reverse().find((b) => pointInBoxBev(b, dragStart.x, dragStart.y))
      selectedId.value = hit?.id ?? null
      syncViewer()
      return
    }

    // 否则：收集矩形内的点索引 → 自动拟合出 3D 框
    if (!cloud.value) return
    const x0 = Math.min(dragStart.x, dragEnd.x), x1 = Math.max(dragStart.x, dragEnd.x)
    const y0 = Math.min(dragStart.y, dragEnd.y), y1 = Math.max(dragStart.y, dragEnd.y)
    const indices: number[] = []
    const pos = cloud.value.positions
    for (let i = 0; i < cloud.value.count; i++) {
      const px = pos[i * 3], py = pos[i * 3 + 1]
      if (px >= x0 && px <= x1 && py >= y0 && py <= y1) indices.push(i)
    }
    if (indices.length < 5) {
      statusText.value = '框选区域内点数太少，无法拟合'
      return
    }
    // 用 PCA 估计主方向，再据此拟合（这两步是自动标注的核心算法）
    const yaw = estimateYawByPCA(pos, indices)
    const fitted = fitBoxToPoints(pos, indices, yaw)
    const cat = DEFAULT_CATEGORIES.find((c) => c.name === currentCategory.value)!
    const box: Box3D = {
      id: nextId(),
      label: currentCategory.value,
      position: fitted?.position ?? { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: cat.defaultSize[2] / 2 },
      scale: fitted?.scale ?? { x: x1 - x0, y: y1 - y0, z: cat.defaultSize[2] },
      yaw: fitted?.yaw ?? 0,
    }
    mutate('新建框', () => {
      boxes.value.push(box)
      selectedId.value = box.id
    })
    statusText.value = `新建框 ${box.label} #${box.id}（用 ${indices.length} 个点自动拟合）`
  }

  function onWheel(e: WheelEvent) {
    if (mode.value !== 'bev') return
    const viewer = core.getViewer()
    if (!viewer) return
    e.preventDefault()
    viewer.zoomBev(e.deltaY > 0 ? 5 : -5)
  }

  function nextId(): string {
    const max = boxes.value.reduce((m, b) => Math.max(m, Number(b.id) || 0), 0)
    return String(max + 1)
  }

  /** 选中框时记录"编辑前"快照，供跨帧传播计算增量 */
  function selectBox(id: string) {
    selectedId.value = id
    const b = boxes.value.find((x) => x.id === id)
    origin.value = b ? cloneBoxes([b])[0] : null
    syncViewer()
  }

  /**
   * 属性面板统一入口：所有属性修改都可撤销，且同类连续修改（拖滑杆）合并为一条历史。
   * 注意 mutate 会替换 boxes 数组，所以回调里必须用 id 重新查找框，不能持有旧引用。
   */
  function setBoxProp(prop: string, value: number | string) {
    const id = selectedId.value
    if (!id) return
    mutate('修改属性', () => {
      const b = boxes.value.find((x) => x.id === id)
      if (!b) return
      switch (prop) {
        case 'label': b.label = value as string; break
        case 'x': b.position.x = value as number; break
        case 'y': b.position.y = value as number; break
        case 'z': b.position.z = value as number; break
        case 'length': b.scale.x = value as number; break
        case 'width': b.scale.y = value as number; break
        case 'height': b.scale.z = value as number; break
        case 'yaw': b.yaw = value as number; break
      }
    }, `prop:${id}:${prop}`)
  }

  // ---- 撤销重做 ----
  function doUndo() {
    const step = core.undoState()
    if (!step) return
    boxes.value = step.state
    if (selectedId.value && !boxes.value.some((b) => b.id === selectedId.value)) selectedId.value = null
    core.syncHistoryUi()
    syncViewer()
    statusText.value = `已撤销：${step.label}`
  }

  function doRedo() {
    const step = core.redoState()
    if (!step) return
    boxes.value = step.state
    if (selectedId.value && !boxes.value.some((b) => b.id === selectedId.value)) selectedId.value = null
    core.syncHistoryUi()
    syncViewer()
    statusText.value = `已重做：${step.label}`
  }

  // ---- 导入导出 ----
  function doExport() {
    downloadJson('labels.json', serializeLabels(boxes.value))
    statusText.value = `已导出 ${boxes.value.length} 个框（兼容 SUSTechPOINTS 格式）`
  }

  async function onLabelFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    try {
      boxes.value = parseLabels(await file.text())
      selectedId.value = null
      resetHistory()
      syncViewer()
      statusText.value = `已导入 ${boxes.value.length} 个标注框`
    } catch (err) {
      statusText.value = `导入失败：${(err as Error).message}`
    }
  }

  // ---- 键盘快捷键：编辑选中的框 ----
  function onKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    const box = core.selectedBox.value
    const key = e.key.toLowerCase()

    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault()
      doExport()
      return
    }
    // 撤销/重做：即使没有选中框也要能用
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
    if (!box) return
    const step = e.shiftKey ? 0.5 : 0.1
    // mergeKey 把连续按同一个键（或连续拖滑杆）合并成一条历史
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
        mutate('删除框', () => {
          boxes.value = boxes.value.filter((b) => b.id !== box.id)
          selectedId.value = null
        })
        break
      default: return
    }
    e.preventDefault()
  }

  return {
    currentCategory, labelInput, onMouseDown, onMouseMove, onMouseUp, onWheel,
    selectBox, setBoxProp, doUndo, doRedo, doExport, onLabelFile, onKeyDown,
  }
}
