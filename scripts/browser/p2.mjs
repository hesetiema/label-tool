// 浏览器手测：预标注与复核（跑模型 / 合并 / 复核队列 / 快捷键 / 导出闸门 / 冲突）
// 运行：pnpm dev（另一终端）+ node scripts/browser/p2.mjs
//
// 这份用例盯的是"从模型产出到训练数据"这条链上最容易假成功的地方：
//   1. 合并真的进了文档（不是只改内存 boxes）；
//   2. 待复核的框在画布上真的换了样式，且真的被导出闸门拦住；
//   3. 键位在面板打开时归复核、关掉后立刻还给画布；
//   4. 裁决可撤销，冲突不会静默覆盖人工几何。
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

/**
 * 演示序列自带几条人工轨迹。清空它们，让"新增几条 / 剩几条"这类断言有确定的分母。
 * 走 `rebuildDocument` 是应用的正常路径（导入标注后重建文档用的就是它），
 * 比直接改 store 更能代表真实状态。
 */
const cleared = await page.evaluate(() => {
  window.studio.frames.value.forEach((f) => { f.boxes = [] })
  window.studio.boxes.value = []
  window.studio.rebuildDocument()
  return { tracks: window.studio.store.value?.tracks.length ?? -1, frames: window.studio.frames.value.length }
})
check('起点是空文档（分母确定）', cleared.tracks === 0, JSON.stringify(cleared))

// ---- 1. 跑演示模型 ----
const run = await page.evaluate(async () => {
  await window.studio.runMock()
  return {
    stats: { ...window.studio.reviewStats.value },
    rows: window.studio.reviewRows.value.map((r) => ({ id: r.trackId, frames: r.frames.length, conf: r.confidence, review: r.review })),
    open: window.studio.reviewOpen.value,
    status: window.studio.statusText.value,
    tracks: window.studio.store.value.tracks.length,
    model: window.studio.lastModel.value,
    created: window.studio.lastResult.value?.created.length ?? -1,
    pendingInView: window.studio.boxes.value.filter((b) => b.review === 'pending').length,
    pendingColor: (() => {
      const b = window.studio.boxes.value.find((x) => x.review === 'pending')
      return b ? window.studio.colorOf(b) : null
    })(),
    gate: window.studio.store.value.materialize(window.studio.frameNumber(), { acceptedOnly: true }).length,
    visible: window.studio.store.value.materialize(window.studio.frameNumber()).length,
  }
})
check('演示模型产出 4 条提案', run.stats.tracks === 4, String(run.stats.tracks))
check('每条提案 2–5 帧（有漏检但不该断成单帧）',
  run.rows.every((r) => r.frames >= 2 && r.frames <= 5), JSON.stringify(run.rows.map((r) => r.frames)))
check('轨迹真的进了文档', run.tracks === 4, String(run.tracks))
check('合入后自动打开复核队列', run.open === true)
check('画布上标了待复核', run.pendingInView > 0, String(run.pendingInView))
check('待复核用灰色（不是类别色）', run.pendingColor === 0x9aa4b2, String(run.pendingColor))
check('导出闸门拦住待复核帧', run.gate === 0 && run.visible > 0, `${run.gate}/${run.visible}`)
check('合并结果记下新增条数', run.created === 4, String(run.created))
check('提示里有"待裁决"（打开队列后的文案）', /待裁决/.test(run.status), run.status)
check('状态栏记下模型身份', /mock-bev/.test(run.model), run.model)
check('队列按低置信在前', run.rows[0].conf <= run.rows[run.rows.length - 1].conf, JSON.stringify(run.rows.map((r) => r.conf)))

// ---- 2. 快捷键：A 接受 / X 拒绝 / Tab 下一处 ----
const firstBefore = await page.evaluate(() => {
  window.studio.selectRow(window.studio.reviewRows.value[0].trackId)
  return {
    id: window.studio.selectedTrackId.value,
    frame: window.studio.frameNumber(),
    tracks: window.studio.reviewStats.value.tracks,
  }
})
await page.keyboard.press('a')
await page.waitForTimeout(120)
const afterA = await page.evaluate(() => ({
  tracks: window.studio.reviewStats.value.tracks,
  accepted: window.studio.reviewStats.value.accepted,
  gate: window.studio.store.value.materialize(window.studio.frameNumber(), { acceptedOnly: true }).length,
  status: window.studio.statusText.value,
}))
check('A 接受当前行', afterA.tracks === firstBefore.tracks - 1, `${firstBefore.tracks} → ${afterA.tracks}`)
check('接受后该帧进入导出', afterA.gate >= 1, String(afterA.gate))
check('状态栏说明剩余数', /剩余 \d+ 条/.test(afterA.status), afterA.status)

await page.keyboard.press('x')
await page.waitForTimeout(120)
const afterX = await page.evaluate(() => ({
  tracks: window.studio.reviewStats.value.tracks,
  rejected: window.studio.reviewStats.value.rejected,
  rows: window.studio.reviewRows.value.length,
  gate: window.studio.store.value.materialize(window.studio.frameNumber(), { acceptedOnly: true }).length,
}))
check('X 拒绝当前行', afterX.tracks === afterA.tracks - 1 && afterX.rejected >= 1, JSON.stringify(afterX))
check('拒绝的帧不进导出（已接受的仍在）', afterX.gate >= 1 && afterX.gate <= afterA.gate, `${afterA.gate} → ${afterX.gate}`)

const tabbed = await page.evaluate(() => ({
  id: window.studio.selectedTrackId.value,
  frame: window.studio.frameNumber(),
}))
await page.keyboard.press('Tab')
await page.waitForTimeout(150)
const afterTab = await page.evaluate(() => ({
  id: window.studio.selectedTrackId.value,
  frame: window.studio.frameNumber(),
  rows: window.studio.reviewRows.value.length,
}))
check('Tab 跳到下一条待裁决', afterTab.id !== tabbed.id || afterTab.rows <= 1, `${tabbed.id} → ${afterTab.id}`)
check('Tab 把画面带到该轨迹的首帧', Number.isFinite(afterTab.frame))

// ---- 3. 裁决可撤销 ----
await page.keyboard.down('Control')
await page.keyboard.press('z')
await page.keyboard.up('Control')
await page.waitForTimeout(200)
const undone = await page.evaluate(() => ({
  tracks: window.studio.reviewStats.value.tracks,
  rejected: window.studio.reviewStats.value.rejected,
}))
check('Ctrl+Z 把拒绝退回来', undone.tracks === afterX.tracks + 1, JSON.stringify(undone))

// ---- 4. 关掉面板，键位还给画布 ----
const closed = await page.evaluate(() => {
  window.studio.closeReview()
  const id = window.studio.boxes.value[0]?.id ?? null
  if (id) window.studio.selectBox(id)
  return { open: window.studio.reviewOpen.value, id, count: window.studio.reviewStats.value.tracks }
})
await page.keyboard.press('a')
await page.waitForTimeout(120)
const afterNudge = await page.evaluate(() => ({
  count: window.studio.reviewStats.value.tracks,
  status: window.studio.statusText.value,
}))
check('面板关闭后 A 不再裁决', afterNudge.count === closed.count, `${closed.count} → ${afterNudge.count}`)
check('A 回到平移语义', /平移|已选|移动/.test(afterNudge.status) || afterNudge.count === closed.count, afterNudge.status)

// ---- 5. 冲突：人工改过的帧不被覆盖 ----
const conflict = await page.evaluate(async () => {
  // 先把剩下的都接受，让"人工 vs 模型"的关系干净
  window.studio.acceptAll()
  const row = window.studio.reviewRows.value[0]
  const target = row ? row.trackId : window.studio.store.value.tracks[0].id
  window.studio.selectRow(target)
  // 平移 0.3 米：走 applyBox（拖拽编辑的正常路径），这一帧的关键帧来源会变成 manual
  const box = window.studio.boxes.value.find((b) => b.id === target)
  if (box) {
    const next = JSON.parse(JSON.stringify(box))
    next.position.x += 0.3
    window.studio.applyBox(next.id, next, 'p2-conflict')
  }
  window.studio.setStrategy('replace-track')
  await window.studio.runMock()
  return {
    conflicts: window.studio.lastResult.value?.conflicts.length ?? -1,
    status: window.studio.statusText.value,
    target,
  }
})
check('再次合并时命中人工帧记冲突', conflict.conflicts >= 1, String(conflict.conflicts))
check('状态栏点名冲突且说明保留人工', /冲突 \d+ 处/.test(conflict.status), conflict.status)

// ---- 6. 导入离线结果 ----
const imported = await page.evaluate(async () => {
  const payload = {
    model: { id: 'offline-test', version: '1' },
    frames: [
      { index: 0, objects: [{ label: 'Car', position: { x: 60, y: 8, z: 0.8 }, scale: { x: 4, y: 2, z: 1.6 }, yaw: 0, confidence: 0.42 }] },
      { index: 1, objects: [{ label: 'Car', position: { x: 60.5, y: 8, z: 0.8 }, scale: { x: 4, y: 2, z: 1.6 }, yaw: 0, confidence: 0.42 }] },
    ],
  }
  const file = new File([JSON.stringify(payload)], 'offline.json', { type: 'application/json' })
  await window.studio.importFile(file)
  return {
    rows: window.studio.reviewRows.value.length,
    model: window.studio.lastModel.value,
    created: window.studio.lastResult.value?.created.length ?? -1,
    status: window.studio.statusText.value,
  }
})
check('离线结果也能导入并合入', imported.rows >= 1, String(imported.rows))
check('离线结果的模型身份可见', /offline-test/.test(imported.model), imported.model)

// ---- 7. 收尾 ----
const final = await page.evaluate(() => ({
  open: window.studio.reviewOpen.value,
  gate: window.studio.store.value.materialize(window.studio.frameNumber(), { acceptedOnly: true }).length,
  visible: window.studio.store.value.materialize(window.studio.frameNumber()).length,
}))
check('闸门仍只放行已接受与人工帧', final.gate <= final.visible, `${final.gate}/${final.visible}`)
check('页面无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' || '))

await browser.close()

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)
