/**
 * ============================================================
 * EditSession —— 把"老代码改 Box3D"翻译成命令
 * ============================================================
 *
 * 双写期的核心适配器。旧编辑代码（拖拽、方向键、属性面板、粘贴……）
 * 全部是在 `boxes.value` 上直接改字段，逐处改成"构造命令"要动 30+ 个调用点，
 * 一次性换心风险太高。
 *
 * 这里换个方向：编辑前后各物化一次当前帧，按 `trackId` 对比差异，
 * 自动生成 createTrack / setKeyframe / setClass / setObservation / deleteTracks。
 *
 * 【为什么按 id 而不是对象引用匹配】
 *   拖拽时数组元素可能被替换；按引用对比会把"改了一个字段"误判成"删除 + 新建"，
 *   撤销时就会丢掉原来的关键帧历史。
 *
 * 【已知边界】
 *   - 只对比当前帧，跨帧操作（插值/传播/复制到其他帧）走各自的命令，不走这里。
 *   - attributes 暂不参与 diff：属性面板目前只编辑几何与类别。
 */
import type { Box3D } from '../../core/types'
import type { Command, CommandData } from '../model/command'
import { makeCommand } from '../model/command'
import type { BoxGeometry } from '../model/geometry'
import { geometryEquals, toGeometry } from '../model/geometry'
import type { ObservationState, Track, Visibility } from '../model/track'
import { cloneTrack, createTrackRecord } from '../model/track'
import type { TrackId } from '../model/ids'
import type { Box3DView } from './materialize'

export interface EditTarget {
  readonly frame: number
  materialize(frame: number): Box3DView[]
  getTrack(id: TrackId): Track | undefined
  nextTrackId(): TrackId
}

function viewState(view: Box3D): ObservationState | null {
  const v = (view.visibility ?? 'visible') as Visibility
  if (v === 'visible') return null
  return { visibility: v, source: { kind: 'manual' }, review: 'none' }
}

export class EditSession {
  private before: Map<TrackId, Box3DView>
  private readonly frame: number
  private readonly target: Omit<EditTarget, 'frame'>

  constructor(target: Omit<EditTarget, 'frame'>, frame: number) {
    this.target = target
    this.frame = frame
    // 以真值为准拍快照，而不是信 boxes.value：boxes 可能被别处改脏
    this.before = new Map(target.materialize(frame).map((v) => [v.id, v]))
  }

  /** 编辑前某一帧的框视图（诊断/测试用） */
  snapshot(): Box3DView[] {
    return [...this.before.values()]
  }

  /**
   * 编辑后对比。
   * @param after 编辑后的当前帧框（通常是 boxes.value）
   */
  diffAfter(after: Box3D[], label: string, coalesceKey?: string): Command | null {
    const children: CommandData[] = []
    const seen = new Set<TrackId>()

    for (const view of after) {
      seen.add(view.id)
      const before = this.before.get(view.id)

      // ---- 新建 ----
      if (!before) {
        children.push({
          type: 'createTrack',
          track: createTrackRecord({
            id: view.id,
            classId: view.label,
            frame: this.frame,
            geometry: toGeometry(view),
          }),
        })
        continue
      }

      // ---- 类别 ----
      if (before.label !== view.label) {
        children.push({ type: 'setClass', trackId: view.id, before: before.label, after: view.label })
      }

      // ---- 几何 ----
      const geoBefore: BoxGeometry = toGeometry(before)
      if (!geometryEquals(geoBefore, view)) {
        children.push({
          type: 'setKeyframe',
          trackId: view.id,
          frame: this.frame,
          before: geoBefore,
          after: toGeometry(view),
        })
      }

      // ---- 可见性 ----
      const stateBefore = viewState(before)
      const stateAfter = viewState(view)
      const vb = stateBefore?.visibility ?? 'visible'
      const va = stateAfter?.visibility ?? 'visible'
      if (vb !== va) {
        children.push({
          type: 'setObservation',
          trackId: view.id,
          frame: this.frame,
          before: stateBefore,
          after: stateAfter,
        })
      }
    }

    // ---- 删除 ----
    const removed: Track[] = []
    for (const id of this.before.keys()) {
      if (seen.has(id)) continue
      const track = this.target.getTrack(id)
      if (track) removed.push(cloneTrack(track))
    }
    if (removed.length) children.push({ type: 'deleteTracks', tracks: removed })

    if (!children.length) return null
    if (children.length === 1) return makeCommand(children[0], { label, coalesceKey })
    return makeCommand({ type: 'batch', commands: children }, { label, coalesceKey })
  }
}
