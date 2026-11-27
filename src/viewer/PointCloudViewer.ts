/**
 * ============================================================
 * Three.js 渲染器 —— 把数据与交互连起来的桥梁
 * ============================================================
 *
 * 只有「一个」3D 透视视口。顶视 / 侧视 / 正视由 Stage 底部的
 * 三联正交视图负责（2D 投影，见 components/OrthoView.vue）。
 *
 * 为什么砍掉原来的 BEV WebGL 场景：
 *  1. CVAT 的工作流是「3D 看整体，Top 画框，Side 调高度」，顶视只需要 2D 投影；
 *  2. 一个场景少一半几何体与材质，同步逻辑也少一半；
 *  3. 正交视图用 2D canvas 画点云，拖拽手柄的命中测试直接用屏幕距离，比 raycast 稳。
 *
 * 坐标系仍是 z-up（KITTI 约定），所以相机显式 camera.up.set(0,0,1)。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Box3D, PointCloud } from '../core/types'
import type { Trajectory } from '../core/sequence/sequence'
import type { CameraPose, CameraTrajectory } from '../core/camera/cameraTrajectory'
import { boxToVertices } from '../core/geometry/box'
import { labelsToColors, semanticClassesOf } from '../core/semantics'
import { cloudColorsFor } from '../core/geometry/colorize'

export interface AppearanceOptions {
  colorBy: 'label' | 'instance'
  /** 点云着色：默认淡蓝 / 按逐点语义类别 / 按强度 / 按高度 */
  pointColorBy: 'default' | 'semantic' | 'intensity' | 'height'
  opacity: number
  outlinedBorders: boolean
  showOrientation: boolean
}

interface BoxVisual {
  edges: THREE.LineSegments
  faces: THREE.Mesh
  label: THREE.Sprite
  orientation: THREE.Line
  /** 变换 / 选中 / 颜色签名，没变就跳过重建 */
  sig: string
  labelText: string
  color: number
}

const EDGE_INDICES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
]

const tmpMatrix = new THREE.Matrix4()
const tmpQuat = new THREE.Quaternion()
const tmpVec = new THREE.Vector3()

/**
 * 渲染层看到的框：Box3D 加上可选的复核状态。
 *
 * 【为什么用交叉类型而不是改 Box3D】导出格式、正交视图、老代码都吃 Box3D；
 * 复核是流程概念，只有画面需要。交叉类型让"多传两个字段"零成本成立，
 * 也不需要把 core 的类型改成"知道标注流程"的样子。
 */
export type RenderBox = Box3D & {
  review?: 'none' | 'pending' | 'accepted' | 'rejected' | 'conflict'
  confidence?: number
}

/** 这一帧该不该画成虚线：预测/遮挡之外，待复核与已拒绝也是"未确认" */
function isDashed(box: RenderBox): boolean {
  if (box.visibility === 'occluded' || box.visibility === 'predicted') return true
  return box.review === 'pending' || box.review === 'rejected'
}

/**
 * 占据层的渲染输入。
 *
 * 【为什么是结构类型而不是 import domain 的 OccupancyGridSpec】
 *   渲染器只关心"网格怎么摆、哪些格是满的、每格什么类"，
 *   不关心这个 spec 是从文档来的还是临时算的。结构类型让 viewer 不依赖 domain，
 *   `check-layers` 的约束也就自然成立（虽然它只禁 domain → UI，方向反过来同样该干净）。
 */
export interface OccupancyLayerData {
  resolution: number
  origin: { x: number; y: number; z: number }
  size: { x: number; y: number; z: number }
  classIds: string[]
  occupied: Uint32Array
  labels: Uint8Array
}

export interface OccupancyLayerOptions {
  /** 只显示这个高度区间（world z，米） */
  slice?: [number, number] | null
  /** 类别配色。默认统一冷灰，调用方通常传类别色 */
  colorOf?: (classId: string, classIndex: number) => number
}

export class PointCloudViewer {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private container: HTMLElement
  private cloudPoints?: THREE.Points
  /** 当前点云引用：切换语义着色时需要用它重建颜色缓冲 */
  private currentCloud?: PointCloud
  private boxVisuals = new Map<string, BoxVisual>()
  /** 悬停光晕：单独一层，不进框的签名缓存（否则鼠标每掠过一次就重建一个框的材质） */
  private hoverVisual?: { sig: string; obj: THREE.LineSegments }

  private trajLayer?: THREE.Group
  private lastTracks: Trajectory[] | null = null
  private lastTrackFrame = -1
  private lastTrackSelected: string | null = null

  private cameraTrajLayer?: THREE.Group
  private cameraRoll = 0
  private watermarkSprite?: THREE.Sprite

  private appearance: AppearanceOptions = {
    colorBy: 'label',
    pointColorBy: 'default',
    opacity: 0.9,
    outlinedBorders: true,
    showOrientation: true,
  }

  /** 脏标记：只有数据 / 相机变化时才重绘，空闲时不再满帧跑 GPU */
  private needsRender = true
  private disposed = false
  /**
   * WebGL 上下文是否已丢失。丢失期间 `render()` 直接返回 —— 往一个失效的上下文
   * 提交命令只会刷控制台错误，而且 GPU 进程恢复要几秒，这期间的帧全是废的。
   */
  private contextLost = false
  /** 上下文丢失/恢复时通知外部（顶部状态条要告诉用户"不是你的数据没了"） */
  private readonly onContextChange?: (status: 'lost' | 'restored') => void

  constructor(container: HTMLElement, opts: { onContextChange?: (status: 'lost' | 'restored') => void } = {}) {
    this.onContextChange = opts.onContextChange
    this.container = container
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 3000)
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(30, -40, 30)
    this.camera.lookAt(0, 0, 0)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.target.set(0, 0, 0)
    this.controls.addEventListener('change', () => {
      this.needsRender = true
    })

    this.scene.add(this.camera)
    this.scene.background = new THREE.Color(0x0f1219)

    const grid = new THREE.GridHelper(200, 40, 0x2a3550, 0x1a2030)
    grid.rotation.x = Math.PI / 2
    this.scene.add(grid)
    this.scene.add(new THREE.AxesHelper(4))

    window.addEventListener('resize', this.onResize)
    this.renderer.domElement.addEventListener('dblclick', this.onDoubleClickFit)
    /*
     * 上下文丢失是**必然会发生**的，不是异常路径：GPU 驱动崩溃/升级、笔记本
     * 切换独显、系统休眠后唤醒、显存被别的标签页挤爆，都会触发。默认行为是
     * 画布变黑且永不恢复 —— 用户看到的就是"刚才还好好的，现在点什么都没反应"。
     * `preventDefault()` 才能让浏览器有机会把上下文还回来，否则不会触发 restored。
     */
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost)
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored)
  }

  private onContextLost = (e: Event) => {
    // 不 preventDefault 的话浏览器不会尝试恢复，restored 永远不会来
    e.preventDefault()
    this.contextLost = true
    this.onContextChange?.('lost')
  }

  /**
   * 上下文回来了：three 会重建自己的 GL 状态，但 GPU 侧的 buffer / 纹理已经全部作废，
   * 而 BufferGeometry 上的数据还在 CPU 内存里 —— 所以最省事的做法是整套重新上传。
   * 只重建点云与框，相机与轨道控制器的状态保持不动，用户的视角不会被重置。
   */
  private onContextRestored = () => {
    this.contextLost = false
    if (this.currentCloud) this.setPointCloud(this.currentCloud)
    for (const v of this.boxVisuals.values()) v.sig = ''
    this.needsRender = true
    this.onContextChange?.('restored')
  }

  private onResize = () => {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.needsRender = true
  }

  private onDoubleClickFit = () => {
    this.controls.target.set(0, 0, 0)
    this.camera.position.set(30, -40, 30)
    this.controls.update()
    this.needsRender = true
  }

  resize() {
    this.onResize()
  }
  requestRender() {
    this.needsRender = true
  }

  /**
   * 当前该用哪份颜色：
   *   语义模式有标签 → 语义色
   *   强度 / 高度模式 → 现算的色带（`core/geometry/colorize.ts`）
   *   其余 → PCD 自带颜色（没有就交给材质默认色）
   * 与正交视图共用 `cloudColorsFor`，保证两边对同一模式的取色一致。
   */
  private effectiveColors(cloud: PointCloud): Float32Array | undefined {
    if (this.appearance.pointColorBy === 'semantic' && cloud.labels?.length) {
      return labelsToColors(cloud.labels, semanticClassesOf(cloud))
    }
    const ramp = cloudColorsFor(cloud, this.appearance.pointColorBy)
    if (ramp) return ramp
    return cloud.colors
  }

  /** 加载/替换点云。用 BufferGeometry 一次性上传 GPU，避免逐点绘制 */
  setPointCloud(cloud: PointCloud) {
    if (this.cloudPoints) {
      this.scene.remove(this.cloudPoints)
      this.cloudPoints.geometry.dispose()
      ;(this.cloudPoints.material as THREE.Material).dispose()
    }
    this.currentCloud = cloud
    const colors = this.effectiveColors(cloud)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3))
    if (colors) geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const mat = new THREE.PointsMaterial({
      size: 0.12,
      color: colors ? 0xffffff : 0xa9c2dd,
      vertexColors: !!colors,
      sizeAttenuation: true,
    })
    this.cloudPoints = new THREE.Points(geo, mat)
    this.cloudPoints.userData.isCloud = true
    this.scene.add(this.cloudPoints)
    this.needsRender = true
  }

  setAppearance(opts: AppearanceOptions) {
    const changed =
      opts.colorBy !== this.appearance.colorBy ||
      opts.opacity !== this.appearance.opacity ||
      opts.outlinedBorders !== this.appearance.outlinedBorders ||
      opts.showOrientation !== this.appearance.showOrientation
    const pointColorChanged = opts.pointColorBy !== this.appearance.pointColorBy
    this.appearance = { ...opts }
    if (changed) {
      // 外观变了：让签名失效，下一轮 setBoxes 重建材质
      for (const v of this.boxVisuals.values()) v.sig = ''
    }
    if (pointColorChanged && this.currentCloud) this.setPointCloud(this.currentCloud)
  }

  private makeLabelSprite(box: RenderBox, color: number): THREE.Sprite {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 64
    const ctx = canvas.getContext('2d')!
    const css = '#' + color.toString(16).padStart(6, '0')
    ctx.fillStyle = 'rgba(8,12,18,0.78)'
    ctx.fillRect(0, 0, 256, 64)
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 4, 64)
    ctx.fillStyle = '#eef4fb'
    ctx.font = '500 28px system-ui, sans-serif'
    const reviewTag =
      box.review === 'pending'
        ? ` 待复核${box.confidence !== undefined ? ` ${box.confidence.toFixed(2)}` : ''}`
        : box.review === 'conflict'
          ? ' 冲突'
          : box.review === 'rejected'
            ? ' 已拒绝'
            : ''
    const tag = (box.visibility === 'predicted' ? ' 预测' : box.visibility === 'occluded' ? ' 遮挡' : '') + reviewTag
    ctx.fillText(`${box.label} #${box.id}${tag}`, 14, 42)
    const tex = new THREE.CanvasTexture(canvas)
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }))
    sprite.scale.set(5.6, 1.4, 1)
    sprite.renderOrder = 20
    return sprite
  }

  private paintLabelSprite(sprite: THREE.Sprite, box: RenderBox, color: number) {
    const tex = (sprite.material as THREE.SpriteMaterial).map as THREE.CanvasTexture
    const canvas = tex.image as HTMLCanvasElement
    const ctx = canvas.getContext('2d')!
    const css = '#' + color.toString(16).padStart(6, '0')
    ctx.clearRect(0, 0, 256, 64)
    ctx.fillStyle = 'rgba(8,12,18,0.78)'
    ctx.fillRect(0, 0, 256, 64)
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 4, 64)
    ctx.fillStyle = '#eef4fb'
    ctx.font = '500 28px system-ui, sans-serif'
    const reviewTag =
      box.review === 'pending'
        ? ` 待复核${box.confidence !== undefined ? ` ${box.confidence.toFixed(2)}` : ''}`
        : box.review === 'conflict'
          ? ' 冲突'
          : box.review === 'rejected'
            ? ' 已拒绝'
            : ''
    const tag = (box.visibility === 'predicted' ? ' 预测' : box.visibility === 'occluded' ? ' 遮挡' : '') + reviewTag
    ctx.fillText(`${box.label} #${box.id}${tag}`, 14, 42)
    tex.needsUpdate = true
  }

  /** 用 8 角点生成线框，顶点顺序与原仓库一致 */
  private makeEdges(box: RenderBox, color: number): THREE.LineSegments {
    const v = boxToVertices(box)
    const pts: number[] = []
    const p = (i: number) => [v[i * 4], v[i * 4 + 1], v[i * 4 + 2]]
    for (const [a, b] of EDGE_INDICES) pts.push(...p(a), ...p(b))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const predicted = isDashed(box)
    if (predicted) {
      const dashed = new THREE.LineSegments(
        geo,
        new THREE.LineDashedMaterial({
          color,
          dashSize: 0.4,
          gapSize: 0.3,
          transparent: true,
          opacity: 0.75,
          depthTest: false,
        }),
      )
      dashed.computeLineDistances()
      return dashed
    }
    const line = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 1,
        depthTest: false,
      }),
    )
    line.renderOrder = 10
    return line
  }

  private makeFaces(box: Box3D, color: number): THREE.Mesh {
    const geo = new THREE.BoxGeometry(box.scale.x, box.scale.y, box.scale.z)
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: Math.min(0.32, 0.06 + this.appearance.opacity * 0.12),
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(box.position.x, box.position.y, box.position.z)
    mesh.rotation.z = box.yaw
    mesh.renderOrder = 5
    return mesh
  }

  /** 朝向短线：从框中心指向车头，长度随框长变化 */
  private makeOrientation(box: Box3D, color: number): THREE.Line {
    const half = box.scale.x / 2
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(box.position.x, box.position.y, box.position.z + box.scale.z / 2 + 0.02),
      new THREE.Vector3(
        box.position.x + Math.cos(box.yaw) * (half + 0.7),
        box.position.y + Math.sin(box.yaw) * (half + 0.7),
        box.position.z + box.scale.z / 2 + 0.02,
      ),
    ])
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    )
    line.renderOrder = 11
    return line
  }

  /** selLevel：0 未选中 / 1 次选中 / 2 主选中。进签名才能让多选变化触发重建 */
  private boxSignature(box: RenderBox, color: number, selLevel: number): string {
    return [
      box.position.x,
      box.position.y,
      box.position.z,
      box.scale.x,
      box.scale.y,
      box.scale.z,
      box.yaw,
      box.label,
      box.visibility ?? 'visible',
      color,
      selLevel,
      box.review ?? '',
      box.confidence ?? -1,
      this.appearance.outlinedBorders ? 1 : 0,
      this.appearance.showOrientation ? 1 : 0,
      this.appearance.opacity,
    ].join('|')
  }

  /**
   * 同步所有框到场景（增量更新，签名不变直接跳过）。
   * 多选时主选中用黄、次选中用白，和正交视图的配色保持一致。
   */
  setBoxes(
    boxes: RenderBox[],
    selectedIds: ReadonlySet<string>,
    primaryId: string | null,
    colorOf: (box: Box3D) => number,
  ) {
    const seen = new Set<string>()
    let changed = false

    for (const box of boxes) {
      if (!Number.isFinite(box.position.x) || !Number.isFinite(box.scale.x)) continue
      seen.add(box.id)
      const primary = primaryId === box.id
      const selected = primary || selectedIds.has(box.id)
      const color = primary ? 0xffee58 : selected ? 0xffffff : colorOf(box)
      const sig = this.boxSignature(box, color, primary ? 2 : selected ? 1 : 0)
      let vis = this.boxVisuals.get(box.id)

      if (!vis) {
        const edges = this.makeEdges(box, color)
        const faces = this.makeFaces(box, color)
        const label = this.makeLabelSprite(box, color)
        const orientation = this.makeOrientation(box, color)
        vis = { edges, faces, label, orientation, sig, labelText: `${box.label}#${box.id}`, color }
        this.boxVisuals.set(box.id, vis)
        this.scene.add(faces, edges, label, orientation)
        changed = true
      } else if (vis.sig !== sig) {
        // 几何体原地重建（框很小，比维护顶点差量简单可靠）
        vis.edges.geometry.dispose()
        const nextEdges = this.makeEdges(box, color)
        vis.edges.geometry = nextEdges.geometry
        ;(vis.edges.material as THREE.Material).dispose()
        vis.edges.material = nextEdges.material
        if (nextEdges instanceof THREE.LineSegments) {
          ;(vis.edges as THREE.LineSegments).computeLineDistances?.()
        }

        vis.faces.geometry.dispose()
        const nextFaces = this.makeFaces(box, color)
        vis.faces.geometry = nextFaces.geometry
        ;(vis.faces.material as THREE.Material).dispose()
        vis.faces.material = nextFaces.material
        vis.faces.position.copy(nextFaces.position)
        vis.faces.rotation.copy(nextFaces.rotation)

        vis.orientation.geometry.dispose()
        const nextOrient = this.makeOrientation(box, color)
        vis.orientation.geometry = nextOrient.geometry
        ;(vis.orientation.material as THREE.Material).dispose()
        vis.orientation.material = nextOrient.material

        const text = `${box.label}#${box.id}`
        if (vis.labelText !== text || vis.color !== color) {
          this.paintLabelSprite(vis.label, box, color)
          vis.labelText = text
          vis.color = color
        }
        vis.sig = sig
        changed = true
      }

      const zTop = box.position.z + box.scale.z / 2 + Math.max(0.9, box.scale.z * 0.35)
      vis.label.position.set(box.position.x, box.position.y, zTop)
      vis.faces.visible = !this.appearance.outlinedBorders
      vis.orientation.visible = this.appearance.showOrientation
    }

    for (const [id, vis] of this.boxVisuals) {
      if (seen.has(id)) continue
      this.scene.remove(vis.edges, vis.faces, vis.label, vis.orientation)
      vis.edges.geometry.dispose()
      ;(vis.edges.material as THREE.Material).dispose()
      vis.faces.geometry.dispose()
      ;(vis.faces.material as THREE.Material).dispose()
      const labMat = vis.label.material as THREE.SpriteMaterial
      labMat.map?.dispose() // 之前漏了这一步，CanvasTexture 会一直留在显存
      labMat.dispose()
      vis.orientation.geometry.dispose()
      ;(vis.orientation.material as THREE.Material).dispose()
      this.boxVisuals.delete(id)
      changed = true
    }

    if (changed) this.needsRender = true
  }

  /**
   * 悬停高亮：在框外面套一圈更亮的线框。
   * 不做成「改这个框自己的描边颜色」是有意为之——那会破坏 boxSignature 缓存，
   * 鼠标每掠过一格都要重建一次材质。放在独立层里，只有悬停目标变了才重建一条 12 段的线。
   */
  setHover(box: Box3D | null) {
    if (!box) {
      this.clearHover()
      return
    }
    const sig = [
      box.id,
      box.position.x,
      box.position.y,
      box.position.z,
      box.scale.x,
      box.scale.y,
      box.scale.z,
      box.yaw,
    ].join('|')
    if (this.hoverVisual?.sig === sig) return
    this.clearHover()

    // 放大 6% + 固定外扩，视觉上像一圈外发光，也不会被框自己的描边压住
    const halo: Box3D = {
      ...box,
      scale: {
        x: box.scale.x * 1.06 + 0.08,
        y: box.scale.y * 1.06 + 0.08,
        z: box.scale.z * 1.06 + 0.08,
      },
    }
    const obj = this.makeEdges(halo, 0x9fe8ff) as THREE.LineSegments
    obj.renderOrder = 12
    const mat = obj.material as THREE.LineBasicMaterial
    mat.opacity = 0.95
    this.scene.add(obj)
    this.hoverVisual = { sig, obj }
    this.needsRender = true
  }

  private clearHover() {
    if (!this.hoverVisual) return
    this.scene.remove(this.hoverVisual.obj)
    this.hoverVisual.obj.geometry.dispose()
    ;(this.hoverVisual.obj.material as THREE.Material).dispose()
    this.hoverVisual = undefined
    this.needsRender = true
  }

  /**
   * 轨迹叠加：整条路径细线 + 已走过段亮线 + 采样点。
   * 采样点用 Points 一次画完，不再「每个点一个 Mesh」——那是拖动时掉帧的主因。
   */
  setTrajectories(tracks: Trajectory[], currentFrame: number, selectedId: string | null) {
    if (tracks === this.lastTracks && currentFrame === this.lastTrackFrame && selectedId === this.lastTrackSelected)
      return
    this.lastTracks = tracks
    this.lastTrackFrame = currentFrame
    this.lastTrackSelected = selectedId

    if (this.trajLayer) {
      this.scene.remove(this.trajLayer)
      this.trajLayer.traverse((o) => {
        const anyObj = o as THREE.Line | THREE.Points
        anyObj.geometry?.dispose?.()
        const mat = anyObj.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else mat?.dispose?.()
      })
      this.trajLayer = undefined
    }
    if (!tracks.length) {
      this.needsRender = true
      return
    }

    const group = new THREE.Group()
    group.userData.isTrajectoryLayer = true

    for (const tr of tracks) {
      const color = colorOfTrack(tr.id)
      const selected = selectedId === tr.id
      const allPts = tr.points.map((p) => new THREE.Vector3(p.x, p.y, p.z))

      group.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(allPts),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: selected ? 0.95 : 0.55, depthTest: false }),
        ),
      )

      const passed = tr.points.filter((p) => p.frame <= currentFrame)
      if (passed.length >= 2) {
        group.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(passed.map((p) => new THREE.Vector3(p.x, p.y, p.z))),
            new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }),
          ),
        )
      }

      const dots = new THREE.Points(
        new THREE.BufferGeometry().setFromPoints(allPts),
        new THREE.PointsMaterial({ color, size: 0.32, transparent: true, opacity: 0.9, depthTest: false }),
      )
      group.add(dots)

      const now = tr.points.find((p) => p.frame === currentFrame)
      if (now) {
        group.add(
          new THREE.Points(
            new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(now.x, now.y, now.z)]),
            new THREE.PointsMaterial({ color: 0xffffff, size: 0.75, depthTest: false }),
          ),
        )
      }
    }

    this.trajLayer = group
    this.scene.add(group)
    this.needsRender = true
  }

  /* ------------------------------------------------------------------
   * 占据栅格层
   * ------------------------------------------------------------------
   * 【为什么用 InstancedMesh 而不是逐体素 Mesh】
   *   一帧三五万个占用体素，逐个 Mesh 就是三五万个 draw call 级别的对象，
   *   光是建对象就要几百毫秒。实例化把绘制压到一次，位置矩阵放一个 buffer。
   *   超过 6 万体素时退化成点云 —— 那时体素已经小于像素，画方块没有意义。
   *
   * 【为什么切片是"过滤"而不是裁剪平面】
   *   裁剪平面要在片元里做，半透明体素的排序会乱；而"只看 z ∈ [0,2]"
   *   本来就是离散选择，重建实例更简单，也不会出现"切了一半的方块"。
   * ------------------------------------------------------------------ */

  /** 层数据签名：长度 + 内容哈希 + 切片。内容哈希让 ROI 改一格也能被识别 */
  private occSig = ''
  private occObject?: THREE.InstancedMesh | THREE.Points

  setOccupancyLayer(layer: OccupancyLayerData | null, opts: OccupancyLayerOptions = {}) {
    const sig = layer
      ? `${layer.occupied.length}|${hashUint32(layer.occupied)}|${opts.slice?.join(',') ?? ''}|${layer.size.x}x${layer.size.y}x${layer.size.z}|${layer.classIds.join(',')}`
      : 'null'
    if (sig === this.occSig) return
    this.occSig = sig

    if (this.occObject) {
      this.scene.remove(this.occObject)
      this.occObject.geometry.dispose()
      const mat = this.occObject.material as THREE.Material | THREE.Material[]
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat.dispose()
      this.occObject = undefined
    }
    this.needsRender = true
    if (!layer || !layer.occupied.length) return

    const { resolution: res, origin, size } = layer
    const slice = opts.slice ?? null
    const nx = size.x
    const ny = size.y
    const colorOf = opts.colorOf ?? (() => 0x8fa3c8)

    const items: Array<{ x: number; y: number; z: number; color: number }> = []
    for (let k = 0; k < layer.occupied.length; k++) {
      const i = layer.occupied[k]
      const iz = Math.floor(i / (nx * ny))
      const rem = i - iz * nx * ny
      const iy = Math.floor(rem / nx)
      const ix = rem - iy * nx
      const z = origin.z + (iz + 0.5) * res
      if (slice && (z < slice[0] || z > slice[1])) continue
      const classId = layer.classIds[layer.labels[k]] ?? ''
      items.push({
        x: origin.x + (ix + 0.5) * res,
        y: origin.y + (iy + 0.5) * res,
        z,
        color: colorOf(classId, layer.labels[k]),
      })
    }
    if (!items.length) return

    if (items.length > 60_000) {
      const pos = new Float32Array(items.length * 3)
      const col = new Float32Array(items.length * 3)
      const c = new THREE.Color()
      for (let i = 0; i < items.length; i++) {
        pos[i * 3] = items[i].x
        pos[i * 3 + 1] = items[i].y
        pos[i * 3 + 2] = items[i].z
        c.setHex(items[i].color)
        col[i * 3] = c.r
        col[i * 3 + 1] = c.g
        col[i * 3 + 2] = c.b
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
      const points = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          size: res * 0.8,
          vertexColors: true,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.9,
        }),
      )
      points.renderOrder = 3
      this.occObject = points
      this.scene.add(points)
      return
    }

    const geo = new THREE.BoxGeometry(res * 0.94, res * 0.94, res * 0.94)
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    })
    const mesh = new THREE.InstancedMesh(geo, material, items.length)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    const color = new THREE.Color()
    for (let i = 0; i < items.length; i++) {
      tmpMatrix.makeTranslation(items[i].x, items[i].y, items[i].z)
      mesh.setMatrixAt(i, tmpMatrix)
      color.setHex(items[i].color)
      mesh.setColorAt(i, color)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.renderOrder = 3
    mesh.frustumCulled = false
    this.occObject = mesh
    this.scene.add(mesh)
  }

  /**
   * 光流箭头层。
   * `segments` 每 6 个数一对端点（起点 xyz、终点 xyz），由 domain 侧算好。
   * 这里不做任何物理，只负责"把线段画出来"—— 方向对不对是 domain 的事，
   * 渲染层猜方向只会让两边都难测。
   */
  setFlowLayer(segments: Float32Array | null) {
    const sig = segments ? `${segments.length}|${hashFloat32(segments)}` : 'null'
    if (sig === this.flowSig) return
    this.flowSig = sig
    if (this.flowObject) {
      this.scene.remove(this.flowObject)
      this.flowObject.geometry.dispose()
      ;(this.flowObject.material as THREE.Material).dispose()
      this.flowObject = undefined
    }
    this.needsRender = true
    if (!segments || segments.length < 6) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(segments, 3))
    const line = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        color: 0x5ad1ff,
        transparent: true,
        opacity: 0.8,
        depthTest: false,
      }),
    )
    line.renderOrder = 5
    line.frustumCulled = false
    this.flowObject = line
    this.scene.add(line)
  }

  private flowSig = ''
  private flowObject?: THREE.LineSegments

  /** 读取当前 3D 相机位姿，供上层「记录当前视角」使用 */
  getCameraPose(): CameraPose {
    const p = this.camera.position
    const t = this.controls.target
    return {
      position: { x: p.x, y: p.y, z: p.z },
      target: { x: t.x, y: t.y, z: t.z },
      roll: this.cameraRoll,
    }
  }

  /** 应用一个相机位姿。roll 通过绕视线方向旋转 camera.up 实现 */
  applyCameraPose(pose: CameraPose) {
    const pos = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z)
    const target = new THREE.Vector3(pose.target.x, pose.target.y, pose.target.z)
    const dir = new THREE.Vector3().subVectors(target, pos)
    if (dir.lengthSq() < 1e-8) dir.set(0, -1, 0)
    dir.normalize()

    const baseUp = Math.abs(dir.z) > 0.98 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    const rolledUp = baseUp
      .clone()
      .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(dir, pose.roll || 0))
      .normalize()

    this.camera.up.copy(rolledUp)
    this.camera.position.copy(pos)
    this.controls.target.copy(target)
    this.cameraRoll = pose.roll || 0
    this.controls.update()
    this.needsRender = true
  }

  /** 在 3D 视口画出运镜关键帧：连线 + 小球 + 注视方向短线 */
  setCameraTrajectory(traj: CameraTrajectory | null, activeIndex = -1) {
    if (this.cameraTrajLayer) {
      this.scene.remove(this.cameraTrajLayer)
      this.cameraTrajLayer.traverse((o) => {
        const line = o as THREE.Line
        line.geometry?.dispose?.()
        const mat = line.material as THREE.Material | undefined
        mat?.dispose?.()
      })
      this.cameraTrajLayer = undefined
    }
    if (!traj || !traj.frames.length) {
      this.needsRender = true
      return
    }

    const group = new THREE.Group()
    group.userData.isCameraTrajectoryLayer = true
    const positions = traj.frames.map((k) => new THREE.Vector3(k.pose.position.x, k.pose.position.y, k.pose.position.z))

    if (positions.length > 1) {
      group.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(positions),
          new THREE.LineBasicMaterial({ color: 0xffca28, transparent: true, opacity: 0.75, depthTest: false }),
        ),
      )
    }

    traj.frames.forEach((kf, i) => {
      const active = i === activeIndex
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(active ? 0.9 : 0.55, 12, 10),
        new THREE.MeshBasicMaterial({ color: active ? 0x00e5ff : 0xffca28, depthTest: false }),
      )
      dot.position.copy(positions[i])
      group.add(dot)

      const target = new THREE.Vector3(kf.pose.target.x, kf.pose.target.y, kf.pose.target.z)
      if (target.distanceToSquared(positions[i]) > 1e-6) {
        const gaze = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([positions[i], target]),
          new THREE.LineDashedMaterial({
            color: active ? 0x00e5ff : 0xffca28,
            dashSize: 1.2,
            gapSize: 0.8,
            transparent: true,
            opacity: 0.4,
            depthTest: false,
          }),
        )
        gaze.computeLineDistances()
        group.add(gaze)
      }
    })

    this.cameraTrajLayer = group
    this.scene.add(group)
    this.needsRender = true
  }

  /** 水印挂在相机下，canvas.captureStream 会把它一起录进视频 */
  setWatermark(enabled: boolean) {
    if (!enabled) {
      if (this.watermarkSprite) {
        this.camera.remove(this.watermarkSprite)
        const mat = this.watermarkSprite.material as THREE.SpriteMaterial
        mat.map?.dispose()
        mat.dispose()
        this.watermarkSprite = undefined
        this.needsRender = true
      }
      return
    }
    if (this.watermarkSprite) return
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 96
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#e6ecf5'
    ctx.font = 'bold 34px sans-serif'
    ctx.fillText('Point Cloud Label Studio', 18, 62)
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    )
    sprite.position.set(0.58, -0.4, -1)
    sprite.scale.set(0.46, 0.086, 1)
    sprite.renderOrder = 999
    this.camera.add(sprite)
    this.watermarkSprite = sprite
    this.needsRender = true
  }

  /** 暴露底层 canvas，供上层绑定交互事件 */
  renderLoopElement(): HTMLCanvasElement {
    return this.renderer.domElement
  }

  /**
   * 射线拾取：把射线变换到框的局部坐标系，与 AABB 求交。
   * 比拿 12 条边做 raycast 更稳，也更快（框多时优势明显）。
   */
  pickBox(clientX: number, clientY: number, boxes: Box3D[]): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.camera)

    let best: { id: string; dist: number } | null = null
    const half = new THREE.Vector3()
    for (const box of boxes) {
      tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), box.yaw)
      tmpMatrix
        .compose(new THREE.Vector3(box.position.x, box.position.y, box.position.z), tmpQuat, new THREE.Vector3(1, 1, 1))
        .invert()
      const localRay = raycaster.ray.clone().applyMatrix4(tmpMatrix)
      half.set(box.scale.x / 2, box.scale.y / 2, box.scale.z / 2)
      const hit = localRay.intersectBox(new THREE.Box3(half.clone().negate(), half.clone()), tmpVec)
      if (!hit) continue
      const dist = localRay.origin.distanceTo(hit)
      if (!best || dist < best.dist) best = { id: box.id, dist }
    }
    return best?.id ?? null
  }

  /** 正交视图 / 工具条的缩放与复位 */
  zoom(factor: number) {
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target)
    const len = Math.max(1.5, dir.length() * factor)
    dir.setLength(len)
    this.camera.position.copy(this.controls.target).add(dir)
    this.controls.update()
    this.needsRender = true
  }

  resetView() {
    this.controls.target.set(0, 0, 0)
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(30, -40, 30)
    this.cameraRoll = 0
    this.controls.update()
    this.needsRender = true
  }

  /**
   * 根据点云范围自动把相机聚焦到数据上（真实数据范围远大于演示场景，必须自适应）。
   * 统计 xy 的 5%~95% 分位，避免个别超远点把视野撑得过大。
   */
  focusOnCloud(cloud: PointCloud) {
    const xs: number[] = []
    const ys: number[] = []
    const step = Math.max(1, Math.floor(cloud.count / 5000))
    for (let i = 0; i < cloud.count; i += step) {
      xs.push(cloud.positions[i * 3])
      ys.push(cloud.positions[i * 3 + 1])
    }
    xs.sort((a, b) => a - b)
    ys.sort((a, b) => a - b)
    const q = (arr: number[], r: number) => arr[Math.floor(arr.length * r)] ?? 0
    const cx = (q(xs, 0.05) + q(xs, 0.95)) / 2
    const cy = (q(ys, 0.05) + q(ys, 0.95)) / 2
    const span = Math.max(q(xs, 0.95) - q(xs, 0.05), q(ys, 0.95) - q(ys, 0.05), 20)

    this.applyCameraPose({
      position: { x: cx + span * 0.45, y: cy - span * 0.55, z: span * 0.5 },
      target: { x: cx, y: cy, z: 0 },
      roll: 0,
    })
  }

  render() {
    // 上下文丢失期间的每一帧都是废的：直接跳过，等 restored 事件把数据重新传上去
    if (this.contextLost) return
    if (this.disposed) return
    // 阻尼需要每帧推进，但真正渲染只在脏标记置位时发生
    if (this.controls.enableDamping) this.controls.update()
    if (!this.needsRender) return
    this.needsRender = false
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.disposed = true
    window.removeEventListener('resize', this.onResize)
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost)
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored)
    this.renderer.domElement.removeEventListener('dblclick', this.onDoubleClickFit)
    this.setWatermark(false)
    this.setCameraTrajectory(null)
    this.clearHover()
    this.setOccupancyLayer(null)
    this.setFlowLayer(null)
    for (const vis of this.boxVisuals.values()) {
      vis.edges.geometry.dispose()
      ;(vis.edges.material as THREE.Material).dispose()
      vis.faces.geometry.dispose()
      ;(vis.faces.material as THREE.Material).dispose()
      const labMat = vis.label.material as THREE.SpriteMaterial
      labMat.map?.dispose()
      labMat.dispose()
      vis.orientation.geometry.dispose()
      ;(vis.orientation.material as THREE.Material).dispose()
    }
    this.boxVisuals.clear()
    this.cloudPoints?.geometry.dispose()
    this.controls.dispose()
    this.renderer.dispose()
  }
}

/** 轨迹配色：按 id 稳定哈希，同类不同目标也能分清 */
function colorOfTrack(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  const palette = [0x4fc3f7, 0xff7043, 0x66bb6a, 0xab47bc, 0xffca28, 0x26c6da, 0xff4081, 0x8bc34a]
  return palette[Math.abs(h) % palette.length]
}

/** 内容哈希：ROI 改一格但数量不变时，靠它让签名失效 */
function hashUint32(arr: Uint32Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < arr.length; i++) {
    h ^= arr[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

function hashFloat32(arr: Float32Array): number {
  let h = 0x811c9dc5
  // 只看位置字节的前 3 位精度：光流箭头本来就是毫米级近似，
  // 为了 1e-7 的浮点尾数重建整层几何不值得
  for (let i = 0; i < arr.length; i++) {
    h ^= Math.round(arr[i] * 100) | 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}
