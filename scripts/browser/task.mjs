// 浏览器手测：多任务（占据派生 / 渲染层 / ROI 编辑 / 光流 / 一致性 / 导出）
// 运行：pnpm dev（另一终端）+ node scripts/browser/task.mjs
//
// 这份用例盯的是"从框派生出另一份真值"这条链上最容易假成功的地方：
//   1. 占据真的写进了文档（并且是 payload 引用，不是内联字节）；
//   2. 渲染器真的收到了层（实例数 > 0），切片真的减少了实例；
//   3. 单格修改真的可撤销，撤销后缓存不会拿旧字节冒充新内容；
//   4. 一致性校验读到的是同一份占据（不是"算了一遍又丢掉了"）；
//   5. 导出真的产出了两个文件（.occ + spec.json）。
import { loadPlaywright, LAUNCH_OPTS } from './_pw.mjs'

const { chromium } = await loadPlaywright()

const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })

const browser = await chromium.launch(LAUNCH_OPTS)
const ctx = await browser.newContext({ viewport: { width: 1600, height: 980 } })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

await page.goto(APP + '?data=sequence', { waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page.waitForTimeout(1400)

// ---- 0. 起点：5 帧演示序列，自带轨迹 ----
const base = await page.evaluate(() => ({
  frames: window.studio.frames.value.length,
  tracks: window.studio.store.value?.tracks.length ?? -1,
  clouds: window.studio.frames.value.filter((f) => f.cloud.count > 0).length,
}))
check('起点是 5 帧序列', base.frames === 5, String(base.frames))
check('起点有轨迹可派生', base.tracks >= 6, String(base.tracks))
check('5 帧点云都在内存里', base.clouds === 5, String(base.clouds))

// ---- 1. 生成占据：文档 / 引用 / 渲染层 / 统计 ----
const gen = await page.evaluate(async () => {
  const t0 = performance.now()
  await window.studio.generateOccupancy('all')
  const task = window.studio.doc.value?.tasks?.occupancy
  const viewer = window.studio.getViewer()
  const occ = viewer?.occObject
  return {
    ms: Math.round(performance.now() - t0),
    frames: task?.frames?.length ?? -1,
    allPayload: (task?.frames ?? []).every((f) => String(f.ref).startsWith('payload/')),
    spec: task?.spec,
    layerCount: window.studio.occLayer.value?.occupied.length ?? -1,
    instanceCount: occ?.count ?? occ?.geometry?.attributes?.position?.count ?? -1,
    show: window.studio.showOcc.value,
    stats: window.studio.occStatsNow.value,
    status: window.studio.statusText.value,
    entries: window.studio.occEntries.value.length,
  }
})
check('占据写进文档：5 帧', gen.frames === 5, String(gen.frames))
check('每帧都是 payload 引用（字节在 BlobStore）', gen.allPayload === true)
check('规格是默认 200×200×16 @0.4m',
  gen.spec?.size?.x === 200 && gen.spec?.size?.z === 16 && gen.spec?.resolution === 0.4,
  JSON.stringify(gen.spec?.size))
check('渲染层拿到当前帧', gen.layerCount > 0, String(gen.layerCount))
check('渲染器真的建了实例（不是只更新了状态）', gen.instanceCount > 0, String(gen.instanceCount))
check('生成后自动显示占据层', gen.show === true)
check('统计有占用率', (gen.stats?.ratio ?? 0) > 0, JSON.stringify(gen.stats?.ratio))
check('状态栏报了每帧耗时', /占据已生成：5 帧.*ms\/帧/.test(gen.status), gen.status)
check('每帧耗时可接受（< 500ms）', gen.ms / 5 < 500, `${gen.ms}ms / 5 帧`)

// ---- 2. 撤销 / 重做：载荷与渲染层一起回退 ----
const undo = await page.evaluate(async () => {
  window.studio.doUndo()
  // 层数据由 docVersion 的 watcher 跟着文档走：等它跑完再断言，
  // 否则测的是"撤销那一瞬间画面还没刷新"，不是"撤销后层还在"
  await new Promise((r) => setTimeout(r, 200))
  return {
    task: !!window.studio.doc.value.tasks.occupancy,
    layer: !!window.studio.occLayer.value,
  }
})
check('撤销后文档里没有占据', undo.task === false)
check('撤销后渲染层也清掉（不留幽灵）', undo.layer === false)

await page.evaluate(() => { window.studio.doRedo() })
await page.waitForTimeout(300)
const redo = await page.evaluate(() => ({
  frames: window.studio.doc.value.tasks.occupancy?.frames?.length ?? -1,
  layer: window.studio.occLayer.value?.occupied.length ?? -1,
}))
check('重做后占据回来', redo.frames === 5, String(redo.frames))
check('重做后缓存命中（不重新解码）', redo.layer > 0, String(redo.layer))

// ---- 3. ROI 单格修改：可撤销，且引用会变 ----
const paint = await page.evaluate(async () => {
  const before = {
    count: window.studio.occLayer.value.occupied.length,
    ref: window.studio.doc.value.tasks.occupancy.frames.find((f) => f.frame === window.studio.frameNumber())?.ref,
  }
  const box = window.studio.boxes.value[0]
  window.studio.cursor.value = { x: box.position.x, y: box.position.y, z: box.position.z }
  await window.studio.paintVoxel('remove', 'Car')
  const removed = {
    count: window.studio.occLayer.value.occupied.length,
    ref: window.studio.doc.value.tasks.occupancy.frames.find((f) => f.frame === window.studio.frameNumber())?.ref,
    status: window.studio.statusText.value,
  }
  await window.studio.paintVoxel('add', 'Car')
  const added = {
    count: window.studio.occLayer.value.occupied.length,
    ref: window.studio.doc.value.tasks.occupancy.frames.find((f) => f.frame === window.studio.frameNumber())?.ref,
  }
  return { before, removed, added }
})
// 撤销会换回旧引用，缓存随之失效并异步重读 —— 等一拍再断言
const undone = await page.evaluate(async () => {
  window.studio.doUndo()
  await new Promise((r) => setTimeout(r, 250))
  return {
    count: window.studio.occLayer.value?.occupied.length ?? -1,
    ref: window.studio.doc.value.tasks.occupancy.frames.find((f) => f.frame === window.studio.frameNumber())?.ref,
  }
})
check('删一格：体素数 -1', paint.removed.count === paint.before.count - 1,
  `${paint.before.count} → ${paint.removed.count}`)
check('删一格：引用变了（内容寻址）', paint.removed.ref !== paint.before.ref, `${paint.before.ref} → ${paint.removed.ref}`)
check('删一格：状态栏说明可撤销', /可撤销/.test(paint.removed.status), paint.removed.status)
check('补一格：体素数回到原值', paint.added.count === paint.before.count,
  `${paint.removed.count} → ${paint.added.count}`)
check('撤销一步回到删除后的状态', undone.count === paint.removed.count && undone.ref === paint.removed.ref,
  `${undone.count} / ${undone.ref}`)

// ---- 4. 有效性：切片减少实例 ----
const slice = await page.evaluate(() => {
  const viewer = window.studio.getViewer()
  const before = viewer.occObject?.count ?? -1
  window.studio.setSlice(-1, 0.6)
  const afterLow = viewer.occObject?.count ?? -1
  window.studio.setSlice(-1, 5.4)
  const afterFull = viewer.occObject?.count ?? -1
  return { before, afterLow, afterFull, slice: window.studio.occSlice.value }
})
check('切片到 0.6m 后实例变少', slice.afterLow > 0 && slice.afterLow < slice.before,
  `${slice.before} → ${slice.afterLow}`)
check('放开切片后实例恢复', slice.afterFull === slice.before, `${slice.afterLow} → ${slice.afterFull}`)

// ---- 5. 跨任务一致性：干净 → 注入悬空映射 → I3 ----
const crossClean = await page.evaluate(async () => {
  await window.studio.runCrossCheck('current')
  return {
    issues: window.studio.issues.value.length,
    checked: window.studio.lastCheck.value?.checked,
    status: window.studio.statusText.value,
  }
})
check('自洽数据不误报', crossClean.issues === 0, JSON.stringify(crossClean))
check('校验确实跑了本帧', crossClean.checked === 1, String(crossClean.checked))

const crossBad = await page.evaluate(async () => {
  window.studio.doc.value.tasks.semantic = { instanceMap: { '3': 'ghost-99' } }
  window.studio.bumpDoc()
  await window.studio.runCrossCheck('current')
  const issue = window.studio.issues.value[0]
  return {
    codes: window.studio.issues.value.map((i) => i.code),
    target: issue?.targets?.[1]?.trackId,
    status: window.studio.statusText.value,
  }
})
check('悬空语义映射报 I3', crossBad.codes.includes('XT_SEM_INSTANCE_UNMAPPED'), crossBad.codes.join(','))
check('I3 指名悬空的轨迹 id', crossBad.target === 'ghost-99', String(crossBad.target))
check('状态栏汇总问题数', /一致性校验：1 帧里 1 个问题/.test(crossBad.status), crossBad.status)

// ---- 6. 自车运动估计与光流箭头 ----
await page.evaluate(() => { window.studio.gotoFrame(1) })
await page.waitForTimeout(200)
const ego = await page.evaluate(async () => {
  await window.studio.estimateEgo()
  const task = window.studio.doc.value.tasks.flow
  const e = task?.ego?.[0]
  return {
    records: task?.ego?.length ?? -1,
    frame: e?.frame,
    dx: e?.dx, dy: e?.dy, dyaw: e?.dyaw, rmse: e?.rmse,
    status: window.studio.statusText.value,
  }
})
check('自车运动落盘一条（第 1 帧）', ego.records === 1 && ego.frame === 1, JSON.stringify(ego))
check('演示场景地面静止 → 位移接近 0',
  Math.abs(ego.dx) < 0.3 && Math.abs(ego.dy) < 0.3 && Math.abs(ego.dyaw) < 0.05,
  `${ego.dx}, ${ego.dy}, ${ego.dyaw}`)
check('状态栏报内点与残差', /内点 \d+\/\d+.*rmse/.test(ego.status), ego.status)

const flow = await page.evaluate(() => {
  window.studio.toggleFlow()
  const v = window.studio.getViewer()
  return {
    segments: window.studio.flowSegments.value?.length ?? 0,
    lines: v.flowObject?.geometry?.attributes?.position?.count ?? 0,
    show: window.studio.showFlow.value,
    status: window.studio.statusText.value,
  }
})
check('光流箭头层有数据', flow.segments > 0 && flow.show === true, JSON.stringify(flow))
check('渲染器画出了箭头顶点', flow.lines > 0, String(flow.lines))
check('箭头来源被说明（上一帧 → 预测位置）', /上一帧/.test(flow.status), flow.status)

// ---- 7. 导出：两个文件，且非空 ----
const exported = await page.evaluate(async () => {
  const sizes = []
  const orig = URL.createObjectURL
  URL.createObjectURL = (blob) => { sizes.push(blob.size); return orig(blob) }
  const origClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () { /* 不真的下载 */ }
  try {
    await window.studio.exportOccupancy()
  } finally {
    URL.createObjectURL = orig
    HTMLAnchorElement.prototype.click = origClick
  }
  return { sizes, status: window.studio.statusText.value }
})
check('导出产出两个文件', exported.sizes.length === 2, JSON.stringify(exported.sizes))
check('.occ 非空', (exported.sizes[0] ?? 0) > 100, String(exported.sizes[0]))
check('spec.json 非空', (exported.sizes[1] ?? 0) > 50, String(exported.sizes[1]))
check('状态栏提示转换脚本', /occ2npz/.test(exported.status), exported.status)

// ---- 8. 任务面板：挂载 + 五条任务行 ----
await page.getByRole('button', { name: '任务', exact: true }).click()
await page.waitForTimeout(200)
const panel = await page.evaluate(() => {
  const chips = [...document.querySelectorAll('.tk-class-chip')].map((el) => el.textContent?.trim() ?? '')
  // chip 文本形如 "Truck 1233"，取末尾数字求和 —— 用来核对"各格加总 == 占据格数"
  const sum = chips.reduce((n, t) => n + (Number(t.match(/(\d+)$/)?.[1] ?? 0)), 0)
  return {
    rows: document.querySelectorAll('.tk-task').length,
    occTitles: [...document.querySelectorAll('.tk-sec')].map((el) => el.textContent?.trim()),
    hasButtons: [...document.querySelectorAll('.tk-panel button')].map((b) => b.textContent?.trim()),
    chips,
    chipSum: sum,
    occupied: window.studio.occStatsNow.value?.occupied ?? -1,
  }
})
check('任务面板渲染六行（P4 起含 VLA）', panel.rows === 6, String(panel.rows))
check('面板分出三块子任务', panel.occTitles.length === 3, JSON.stringify(panel.occTitles))
check('面板有生成/校验/导出按钮',
  ['生成本帧', '生成全段', '校验本帧', '导出 .occ + spec'].every((t) => panel.hasButtons.includes(t)),
  JSON.stringify(panel.hasButtons))
// 只显示前 3 类时必须补"其余"，否则 chip 加起来对不上占据率，看着像统计出错
check('类别 chip 有"其余"汇总', panel.chips.some((t) => t.startsWith('其余')), JSON.stringify(panel.chips))
check('chip 合计 == 占据格数', panel.chipSum === panel.occupied, `${panel.chipSum} vs ${panel.occupied}`)

// ---- 9. 清除：载荷与层一起清 ----
const cleared = await page.evaluate(async () => {
  await window.studio.clearOccupancy()
  return {
    task: !!window.studio.doc.value.tasks.occupancy,
    layer: !!window.studio.occLayer.value,
    show: window.studio.showOcc.value,
  }
})
check('清除后载荷与层都消失', cleared.task === false && cleared.layer === false, JSON.stringify(cleared))
check('清除后关掉显示开关', cleared.show === false)

// ---- 10. 单帧重算不吃掉其它帧 ----
const single = await page.evaluate(async () => {
  await window.studio.generateOccupancy('frame')
  const one = window.studio.doc.value.tasks.occupancy?.frames?.length ?? -1
  await window.studio.generateOccupancy('all')
  const all = window.studio.doc.value.tasks.occupancy?.frames?.length ?? -1
  await window.studio.generateOccupancy('frame')
  const after = window.studio.doc.value.tasks.occupancy?.frames?.length ?? -1
  return { one, all, after, status: window.studio.statusText.value }
})
check('清除后能重新生成单帧', single.one === 1, String(single.one))
check('再生成全段回到 5 帧', single.all === 5, String(single.all))
check('只重算本帧不会清掉其余帧', single.after === 5, String(single.after))
check('状态栏说明保留了其余帧', /保留其余 4 帧/.test(single.status), single.status)

check('页面无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' || '))

await browser.close()

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)
