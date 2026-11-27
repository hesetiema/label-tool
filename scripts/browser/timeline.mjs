// 浏览器手测：时间线拖拽 / 右键菜单 / 合并保存 / 三个导出入口
// 运行：pnpm dev --port 5199（另一终端）+ node scripts/browser/timeline.mjs
//       或用 APP_URL 指向已起的实例：APP_URL=http://127.0.0.1:5173/ node scripts/browser/timeline.mjs
// Edge 验证：merge-save（真实 IndexedDB）、时间线拖拽改生命周期、右键菜单、新导出入口
import { loadPlaywright, LAUNCH_OPTS } from './_pw.mjs'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'

const { chromium } = await loadPlaywright()

const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })

const browser = await chromium.launch(LAUNCH_OPTS)
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true })
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

await page.goto(APP + '?data=sequence', { waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page.waitForTimeout(2200)

/* ---------------- 1. merge-save（浏览器里的真实事务） ---------------- */
const merge = await page.evaluate(async () => {
  const mod = await import('/src/adapters/studioStore.ts')
  const store = mod.studioStore()
  if (!store) return { err: 'no store' }
  const doc = {
    schema: 2,
    sampleId: 'merge#test',
    sceneId: 'scene',
    range: [0, 5],
    tasks: { boxes: { tracks: [] } },
    meta: { version: 1, baseVersion: 0, updatedAt: Date.now(), updatedBy: 'test', hashes: {} },
  }
  await store.documents.save(doc)
  // 第二个任务段：模拟占据任务写入
  await store.documents.saveTask('merge#test', 'occupancy', {
    voxelSize: 0.2,
    frames: { 0: 'payload/deadbeef0001' },
  })
  // 工作台再次自动保存（只带 boxes）
  await store.documents.save(doc)
  const afterMerge = await store.documents.load('merge#test')
  const listed = await store.documents.listSamples()
  // 显式删除
  await store.documents.removeTask('merge#test', 'occupancy')
  const afterRemove = await store.documents.load('merge#test')
  // 没头就写段：必须报错，而不是留孤儿
  let orphanErr = ''
  try {
    await store.documents.saveTask('never-saved#x', 'occupancy', { frames: {} })
  } catch (e) {
    orphanErr = e.message
  }
  await store.documents.remove('merge#test')
  return {
    mergedTasks: Object.keys(afterMerge?.tasks ?? {}),
    seenInList: listed.some((s) => s.sampleId === 'merge#test'),
    removedTasks: Object.keys(afterRemove?.tasks ?? {}),
    orphanErr,
  }
})
check('第二次 save 不抹掉 occupancy 段', merge.mergedTasks?.includes('occupancy'), JSON.stringify(merge.mergedTasks))
check('合并后的文档仍在列表里', merge.seenInList === true)
check('removeTask 后段被摘掉', !merge.removedTasks?.includes('occupancy'), JSON.stringify(merge.removedTasks))
check('没有头时写任务段会报错', /尚未保存/.test(merge.orphanErr ?? ''), merge.orphanErr)

/* ---------------- 2. 时间线拖拽改生命周期 ---------------- */
await page.waitForSelector('.tl-row', { timeout: 15000 })
const before = await page.evaluate(() => {
  const t = window.studio.store.value.tracks[0]
  return { id: t.id, first: t.lifecycle.first, last: t.lifecycle.last, range: window.studio.doc.value.range }
})

const handle = page.locator('.tl-row').first().locator('.tl-handle').nth(1) // 右端
const box = await handle.boundingBox()
const barBox = await page.locator('.tl-row').first().locator('.tl-bar').boundingBox()
if (box && barBox) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  // 往左拖到约 40% 处
  await page.mouse.move(barBox.x + barBox.width * 0.4, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
}
await page.waitForTimeout(300)
const afterDrag = await page.evaluate(() => {
  const t = window.studio.store.value.tracks[0]
  return {
    first: t.lifecycle.first,
    last: t.lifecycle.last,
    kfs: t.keyframes.length,
    status: window.studio.statusText.value,
  }
})
check(
  '拖右端能改结束帧',
  afterDrag.last < before.last && afterDrag.first === before.first,
  `${before.first}-${before.last} → ${afterDrag.first}-${afterDrag.last}`,
)
check('拖拽不删关键帧', afterDrag.kfs === 3 || afterDrag.kfs > 0, String(afterDrag.kfs))
check('拖拽有状态栏反馈', /生命周期已改为/.test(afterDrag.status), afterDrag.status)

const undone = await page.evaluate(() => {
  window.studio.doUndo()
  const t = window.studio.store.value.tracks[0]
  return { first: t.lifecycle.first, last: t.lifecycle.last }
})
check('一次拖拽只产生一条撤销', undone.last === before.last && undone.first === before.first, JSON.stringify(undone))

/* ---------------- 3. 右键菜单 ---------------- */
await page
  .locator('.tl-row')
  .first()
  .locator('.tl-bar')
  .click({ button: 'right', position: { x: 560, y: 6 } })
await page.waitForTimeout(200)
const menuVisible = await page.locator('.tl-menu').count()
check('右键弹出轨迹菜单', menuVisible === 1)
const menuItems = await page.locator('.tl-menu button').allTextContents()
check(
  '菜单含关键帧/拆分/生命周期/删除',
  menuItems.length >= 6 &&
    menuItems.some((t) => t.includes('补关键帧')) &&
    menuItems.some((t) => t.includes('拆分')) &&
    menuItems.some((t) => t.includes('起点设为')),
  menuItems.join(' | '),
)

// 点"起点设为第 N 帧"应真的生效
await page.locator('.tl-menu button', { hasText: '起点设为' }).first().click()
await page.waitForTimeout(300)
const afterTrim = await page.evaluate(() => {
  const t = window.studio.store.value.tracks[0]
  return { first: t.lifecycle.first, last: t.lifecycle.last, status: window.studio.statusText.value }
})
check('菜单裁剪生效', afterTrim.first > before.first, `${before.first} → ${afterTrim.first}`)
await page.evaluate(() => window.studio.doUndo())

/* ---------------- 4. 新导出入口 ---------------- */
const outDir = 'C:/Users/wuyuxi/AppData/Local/Temp/edge-dl'
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
for (const label of ['整段序列 JSON（插值补帧）', '整段序列 JSON（RTS 平滑）']) {
  await page
    .locator('.topbar button, header button')
    .first()
    .click()
    .catch(() => {})
  const opened = await page.locator('text=' + label).count()
  if (!opened) {
    // 菜单可能没开：点顶栏菜单按钮
    await page
      .locator('[title*="菜单"]')
      .first()
      .click()
      .catch(() => {})
  }
  const btn = page.locator('button', { hasText: label }).first()
  const visible = await btn.isVisible().catch(() => false)
  if (!visible) {
    check(`导出入口存在：${label}`, false, '按钮不可见')
    continue
  }
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
  await btn.click()
  const download = await dl
  if (!download) {
    check(`导出入口可用：${label}`, false, '未触发下载')
    continue
  }
  const file = `${outDir}/${download.suggestedFilename()}`
  await download.saveAs(file)
  const text = readFileSync(file, 'utf8')
  const parsed = JSON.parse(text)
  check(
    `导出可用且 JSON 合法：${label}`,
    parsed.format === 'pcl-label-studio/sequence' && parsed.frames.length > 0,
    `${parsed.frameCount} 帧 / ${parsed.frames.length} 条`,
  )
  await page.keyboard.press('Escape')
}

check('页面无 console 报错', errors.length === 0, errors.slice(0, 4).join(' || '))

await browser.close()
const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)
