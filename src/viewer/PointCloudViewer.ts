/**
 * ============================================================
 * Three.js 渲染器 —— 把数据与交互连起来的桥梁
 * ============================================================
 *
 * 我们维护两个视口（视口 = viewport，一个渲染区域）：
 *  1) 3D 透视视图：可自由旋转的立体视图，符合直觉
 *  2) BEV 鸟瞰视图(Bird's Eye View)：从上往下的正交投影，标注主要在这里做
 *
 * 为什么需要 BEV？因为在顶视图里，xy 平面和屏幕平面一一对应，
 * 拖拽鼠标画矩形 = 在世界上框定一个 xy 区域，非常直观。
 * 3D 视图则用来验证高度、朝向是否贴准。
 *
 * 关键点：因为我们的坐标系 z-up，而 Three.js 默认 y-up，
 * 所以所有相机都要 camera.up.set(0,0,1)。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Box3D, PointCloud } from '../core/types'
import type { Trajectory, TrackPoint } from '../core/sequence'
import { boxToVertices } from '../core/box'
import { DEFAULT_CATEGORIES } from '../core/types'

export type ViewMode = '3d' | 'bev'

interface BoxVisual {
  edges: THREE.LineSegments
  label: THREE.Sprite
}

export class PointCloudViewer {
  private renderer: THREE.WebGLRenderer
  private scene3d = new THREE.Scene()
  private sceneBev = new THREE.Scene()
  private camera3d: THREE.PerspectiveCamera
  private cameraBev: THREE.OrthographicCamera
  private controls: OrbitControls
  private container: HTMLElement
  private cloudPoints3d?: THREE.Points
  private cloudPointsBev?: THREE.Points
  private boxVisuals = new Map<string, { a: BoxVisual; b: BoxVisual }>()
  private bevFrustum = 60 // BEV 正交相机视野大小（米），可缩放
  private mode: ViewMode = '3d'

  /** 轨迹叠加层：同一 id 的多帧中心点连成线，展示目标的运动路径 */
  private trajLines3d?: THREE.Group
  private trajLinesBev?: THREE.Group

  /** 当用户在 BEV 上拖拽画框时，用于实时显示的临时矩形 */
  private draftLine?: THREE.Line

  constructor(container: HTMLElement) {
    this.container = container
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    container.appendChild(this.renderer.domElement)

    // 3D 相机：透视投影，up 设为 z
    this.camera3d = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 2000)
    this.camera3d.up.set(0, 0, 1)
    this.camera3d.position.set(30, -40, 30)
    this.camera3d.lookAt(0, 0, 0)

    // BEV 相机：正交投影，从正上方向下看（沿 -z），up 指向 +y
    const aspect = container.clientWidth / container.clientHeight
    const f = this.bevFrustum / 2
    this.cameraBev = new THREE.OrthographicCamera(-f * aspect, f * aspect, f, -f, 0.1, 1000)
    this.cameraBev.up.set(0, 1, 0)
    this.cameraBev.position.set(0, 0, 200)
    this.cameraBev.lookAt(0, 0, 0)

    // OrbitControls 让 3D 视图可以用鼠标旋转/缩放/平移
    this.controls = new OrbitControls(this.camera3d, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.target.set(0, 0, 0)

    // 两个场景都加网格与坐标轴，帮助建立空间感
    for (const sc of [this.scene3d, this.sceneBev]) {
      sc.background = new THREE.Color(0x10141c)
      const grid = new THREE.GridHelper(200, 40, 0x2a3550, 0x1a2030)
      // GridHelper 默认在 xz 平面（y-up），旋转到 xy 平面（z-up）
      grid.rotation.x = Math.PI / 2
      sc.add(grid)
      sc.add(new THREE.AxesHelper(5))
    }

    window.addEventListener('resize', this.onResize)
  }

  private onResize = () => {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h)
    this.camera3d.aspect = w / h
    this.camera3d.updateProjectionMatrix()
    const aspect = w / h
    const f = this.bevFrustum / 2
    this.cameraBev.left = -f * aspect
    this.cameraBev.right = f * aspect
    this.cameraBev.top = f
    this.cameraBev.bottom = -f
    this.cameraBev.updateProjectionMatrix()
  }

  /** 供外部（布局切换）触发尺寸重算 */
  resize() { this.onResize() }

  setMode(mode: ViewMode) {
    this.mode = mode
    if (mode === '3d') {
      this.controls.enabled = true
      this.renderer.domElement.style.cursor = 'grab'
    } else {
      this.controls.enabled = false
      this.renderer.domElement.style.cursor = 'crosshair'
    }
  }

  /** 加载/替换点云。用 BufferGeometry 一次性上传 GPU，避免逐点绘制 */
  setPointCloud(cloud: PointCloud) {
    for (const sc of [this.scene3d, this.sceneBev]) {
      const old = sc.children.find((o) => o.userData.isCloud) as THREE.Points | undefined
      if (old) {
        old.geometry.dispose()
        sc.remove(old)
      }
    }
    const make = () => {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3))
      if (cloud.colors) geo.setAttribute('color', new THREE.BufferAttribute(cloud.colors, 3))
      const mat = new THREE.PointsMaterial({
        size: 0.12,
        color: cloud.colors ? 0xffffff : 0x8fd4ff,
        vertexColors: !!cloud.colors,
        sizeAttenuation: true,
      })
      const points = new THREE.Points(geo, mat)
      points.userData.isCloud = true
      return points
    }
    this.cloudPoints3d = make()
    this.cloudPointsBev = make()
    this.scene3d.add(this.cloudPoints3d)
    this.sceneBev.add(this.cloudPointsBev)
  }

  /** 生成文字标签精灵，显示类别+ID */
  private makeLabelSprite(box: Box3D): THREE.Sprite {
    const canvas = document.createElement('canvas')
    canvas.width = 256; canvas.height = 64
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'rgba(0,0,0,0.65)'
    ctx.fillRect(0, 0, 256, 64)
    ctx.fillStyle = '#ffffff'
    ctx.font = '30px sans-serif'
    ctx.fillText(`${box.label} #${box.id}`, 8, 42)
    const tex = new THREE.CanvasTexture(canvas)
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }))
    sprite.scale.set(6, 1.5, 1)
    sprite.position.set(box.position.x, box.position.y, box.position.z + box.scale.z / 2 + 1)
    return sprite
  }

  /** 用一个框生成线框对象。用 vertices 保证与原仓库顶点顺序一致 */
  private makeBoxEdges(box: Box3D, color: number): THREE.LineSegments {
    const v = boxToVertices(box)
    const pts: number[] = []
    const p = (i: number) => [v[i * 4], v[i * 4 + 1], v[i * 4 + 2]]
    // 车头面 0-1-2-3，车尾面 4-5-6-7，连线：0-1-2-3-0 与 4-5-6-7-4 与 0-4,1-5,2-6,3-7
    const edges: [number, number][] = [
      [0,1],[1,2],[2,3],[3,0],
      [4,5],[5,6],[6,7],[7,4],
      [0,4],[1,5],[2,6],[3,7],
    ]
    for (const [a, b] of edges) pts.push(...p(a), ...p(b))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false }))
  }

  /** 同步所有框到两个场景（增量更新） */
  setBoxes(boxes: Box3D[], selectedId: string | null) {
    const seen = new Set<string>()
    for (const box of boxes) {
      seen.add(box.id)
      const cat = DEFAULT_CATEGORIES.find((c) => c.name === box.label)
      const color = selectedId === box.id ? 0xffee58 : (cat?.color ?? 0x4fc3f7)
      let vis = this.boxVisuals.get(box.id)
      if (!vis) {
        vis = { a: { edges: this.makeBoxEdges(box, color), label: this.makeLabelSprite(box) }, b: { edges: this.makeBoxEdges(box, color), label: this.makeLabelSprite(box) } }
        this.boxVisuals.set(box.id, vis)
        this.scene3d.add(vis.a.edges, vis.a.label)
        this.sceneBev.add(vis.b.edges, vis.b.label)
      } else {
        // 替换几何体以反映编辑后的框
        for (const v of [vis.a, vis.b]) {
          v.edges.geometry.dispose()
          v.edges.geometry = this.makeBoxEdges(box, color).geometry
          ;(v.edges.material as THREE.LineBasicMaterial).color.setHex(color)
          v.label.position.set(box.position.x, box.position.y, box.position.z + box.scale.z / 2 + 1)
          const tex = (v.label.material as THREE.SpriteMaterial).map as THREE.CanvasTexture
          const canvas = tex.image as HTMLCanvasElement
          const ctx = canvas.getContext('2d')!
          ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(0, 0, 256, 64)
          ctx.fillStyle = '#ffffff'; ctx.font = '30px sans-serif'; ctx.fillText(`${box.label} #${box.id}`, 8, 42)
          tex.needsUpdate = true
        }
      }
    }
    // 删除已不存在的框
    for (const [id, vis] of this.boxVisuals) {
      if (!seen.has(id)) {
        for (const v of [vis.a, vis.b]) {
          v.edges.geometry.dispose(); v.label.material.dispose()
          this.scene3d.remove(v.edges, v.label); this.sceneBev.remove(v.edges, v.label)
        }
        this.boxVisuals.delete(id)
      }
    }
  }

  /**
   * 轨迹叠加：把每条轨迹的多帧中心点连成线，叠加到 3D 与 BEV 场景。
   * @param tracks 轨迹数据（extractTrajectories 的输出）
   * @param currentFrame 当前帧号，用于高亮"已走过"与"当前点"
   * @param selectedId 选中的目标，高亮其整条轨迹
   */
  setTrajectories(tracks: Trajectory[], currentFrame: number, selectedId: string | null) {
    // 先清掉旧的轨迹层，避免重复添加导致内存泄漏与叠影
    for (const sc of [this.scene3d, this.sceneBev]) {
      const old = sc.children.find((o) => o.userData.isTrajectoryLayer) as THREE.Group | undefined
      if (old) {
        old.traverse((o) => {
          const line = o as THREE.Line
          if (line.geometry) line.geometry.dispose()
          const mat = line.material as THREE.Material | undefined
          if (mat) mat.dispose()
        })
        sc.remove(old)
      }
    }

    if (!tracks.length) {
      this.trajLines3d = undefined
      this.trajLinesBev = undefined
      return
    }

    // 每个目标一条独立颜色（按 id 稳定哈希），同类不同车也能一眼分清轨迹
    const colorOf = (id: string): number => {
      const palette = [0x4fc3f7, 0xff7043, 0x66bb6a, 0xab47bc, 0xffca28, 0x26c6da, 0xff4081, 0x8bc34a]
      let h = 0
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
      return palette[Math.abs(h) % palette.length]
    }

    const buildLayer = (isBev: boolean): THREE.Group => {
      const group = new THREE.Group()
      group.userData.isTrajectoryLayer = true
      const zOf = (p: TrackPoint) => (isBev ? 0.35 : p.z) // BEV 贴地显示，3D 用真实高度

      for (const tr of tracks) {
        const color = colorOf(tr.id)
        const selected = selectedId === tr.id

        // 1) 完整轨迹：半透明细线，表示"整条路径"
        const allPts = tr.points.map((p) => new THREE.Vector3(p.x, p.y, zOf(p)))
        const full = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(allPts),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: selected ? 0.95 : 0.6, depthTest: false }),
        )
        group.add(full)

        // 2) 已走过的段（frame <= currentFrame）：亮实线，直观看到"走过哪了"
        const passed = tr.points.filter((p) => p.frame <= currentFrame)
        if (passed.length >= 2) {
          const lit = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(passed.map((p) => new THREE.Vector3(p.x, p.y, zOf(p)))),
            new THREE.LineBasicMaterial({ color, transparent: true, opacity: selected ? 1 : 0.9, depthTest: false }),
          )
          group.add(lit)
        }

        // 3) 采样点小球；当前帧的点放大并染成高亮色
        for (const p of tr.points) {
          const isNow = p.frame === currentFrame
          const dot = new THREE.Mesh(
            new THREE.SphereGeometry(isNow ? (isBev ? 0.7 : 0.55) : 0.3, 10, 8),
            new THREE.MeshBasicMaterial({
              color: isNow ? 0xffffff : color,
              transparent: true,
              opacity: isNow ? 1 : (p.frame <= currentFrame ? 0.95 : 0.45),
              depthTest: false,
            }),
          )
          dot.position.set(p.x, p.y, zOf(p))
          group.add(dot)
        }
      }
      return group
    }

    this.trajLines3d = buildLayer(false)
    this.trajLinesBev = buildLayer(true)
    this.scene3d.add(this.trajLines3d)
    this.sceneBev.add(this.trajLinesBev)
  }

  /** 显示 BEV 上拖拽时的临时矩形（p0,p1 为世界 xy 两点） */
  showDraft(p0: { x: number; y: number }, p1: { x: number; y: number }) {
    if (!this.draftLine) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()])
      this.draftLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x00e5ff }))
      this.sceneBev.add(this.draftLine)
    }
    const z = 0.3
    const pts = [
      new THREE.Vector3(p0.x, p0.y, z), new THREE.Vector3(p1.x, p0.y, z),
      new THREE.Vector3(p1.x, p1.y, z), new THREE.Vector3(p0.x, p1.y, z),
      new THREE.Vector3(p0.x, p0.y, z),
    ]
    this.draftLine.geometry.setFromPoints(pts)
  }

  clearDraft() {
    if (this.draftLine) {
      this.sceneBev.remove(this.draftLine)
      this.draftLine.geometry.dispose()
      this.draftLine = undefined
    }
  }

  /** 屏幕坐标 → BEV 世界 xy 坐标（正交相机的逆投影） */
  screenToBev(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1
    const v = new THREE.Vector3(nx, ny, 0).unproject(this.cameraBev)
    return { x: v.x, y: v.y }
  }

  /** BEV 视图的米/像素换算，供鼠标拖拽阈值使用 */
  getBevScale(): number {
    return this.bevFrustum / this.renderer.domElement.clientHeight
  }

  /** 暴露底层 canvas，供上层绑定交互事件 */
  renderLoopElement(): HTMLCanvasElement {
    return this.renderer.domElement
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
    const spanX = q(xs, 0.95) - q(xs, 0.05)
    const spanY = q(ys, 0.95) - q(ys, 0.05)
    const span = Math.max(spanX, spanY, 20)

    // BEV 视野装下主要数据范围
    this.bevFrustum = Math.min(300, Math.max(30, span * 1.3))
    this.cameraBev.position.set(cx, cy, 200)
    this.cameraBev.lookAt(cx, cy, 0)
    this.onResize()

    // 3D 相机拉远并指向数据中心
    this.camera3d.position.set(cx + span * 0.4, cy - span * 0.5, span * 0.45)
    this.controls.target.set(cx, cy, 0)
    this.controls.update()
  }

  zoomBev(delta: number) {
    this.bevFrustum = Math.min(200, Math.max(10, this.bevFrustum + delta))
    this.onResize()
  }

  render() {
    if (this.mode === '3d') this.controls.update()
    const cam = this.mode === '3d' ? this.camera3d : this.cameraBev
    const sc = this.mode === '3d' ? this.scene3d : this.sceneBev
    this.renderer.render(sc, cam)
  }

  dispose() {
    window.removeEventListener('resize', this.onResize)
    this.controls.dispose()
    this.renderer.dispose()
  }
}
