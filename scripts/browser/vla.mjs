// 浏览器手测：VLA（生成 / 时间线双行 / 区间编辑 / 撤销 / 校验 / 导出 / 清除）
// 运行：pnpm dev --port 5199（另一终端）+ node scripts/browser/vla.mjs，或设 APP_URL 指向已起实例
//
// 这份用例盯的是"语言—动作对齐"在真页面上最容易假成功的地方：
//   1. 指令条真的出现在时间线上（DOM 有 5 段，不是只算了数据没渲染）；
//   2. 动作曲线真的画到 canvas 上（有非透明像素，不是空画布）；
//   3. 改区间走的是可撤销命令，撤销后**时间线也回退**（不只是数据回退）；
//   4. 注入错误后校验真的报出来（规则接线通了，不是面板显示了静态文字）；
//   5. 导出真的产出一个 .jsonl 文件，且内容是单行合法 JSON。
//
// 用 120 帧而不是默认 5 帧：5 帧里放 5 条指令，每条只剩 1 帧，曲线是直线、
// 区间没有可拖的余量，测出来的"通过"没有意义。
import { loadPlaywright, LAUNCH_OPTS } from './_pw.mjs'

const { chromium } = await loadPlaywright()

const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })

const browser = await chromium.launch(LAUNCH_OPTS)
const ctx = await browser.newContext({ viewport: { width: 1600, height: 980 }, acceptDownloads: true })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

await page.goto(APP + '?data=sequence&frames=120', { waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page.waitForTimeout(1600)

// ---- 0. 起点 ----
const base = await page.evaluate(() => ({
  frames: window.studio.frames.value.length,
  range: window.studio.doc.value?.range,
  vla: !!window.studio.doc.value?.tasks?.vla,
}))
check('起点是 120 帧序列', base.frames === 120, String(base.frames))
check('文档范围随之变长', base.range?.[1] === 119, JSON.stringify(base.range))
check('起点没有 VLA 任务', base.vla === false)

// ---- 1. 生成演示：文档 / 通道 / 干净基线 ----
const gen = await page.evaluate(async () => {
  await window.studio.loadDemo()
  await new Promise((r) => setTimeout(r, 200))
  const t = window.studio.doc.value?.tasks?.vla
  return {
    has: !!t,
    segments: t?.instructions?.length ?? -1,
    channels: t?.channels?.map((c) => c.name) ?? [],
    lengths: t?.channels?.map((c) => c.values.length) ?? [],
    hz: t?.hz,
    alignment: t?.alignment?.length ?? -1,
    issues: window.studio.vlaIssues.value.map((i) => i.code),
    status: window.studio.statusText.value,
  }
})
check('VLA 段写进文档', gen.has)
check('生成 5 条指令', gen.segments === 5, String(gen.segments))
check('生成 4 个通道', gen.channels.length === 4, gen.channels.join())
check('通道长度 = 帧数', gen.lengths.every((n) => n === 120), gen.lengths.join())
check('hz 落到载荷', gen.hz === 10, String(gen.hz))
check('对齐关系补齐 5 条', gen.alignment === 5, String(gen.alignment))
check('干净数据零问题', gen.issues.length === 0, gen.issues.join())

// ---- 2. 时间线：指令条 + 曲线 ----
await page.waitForTimeout(300)
const tl = await page.evaluate(() => {
  const bars = [...document.querySelectorAll('.tl-ins')]
  const cv = document.querySelector('.tl-vla-canvas')
  let painted = 0
  if (cv) {
    const g = cv.getContext('2d')
    const d = g.getImageData(0, 0, cv.width, cv.height).data
    // 只统计明显不透明的像素：抗锯齿边缘的 alpha 很低，不能当"画上了"
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) painted++
  }
  return {
    bars: bars.length,
    texts: bars.map((b) => b.textContent?.trim() ?? ''),
    widths: bars.map((b) => b.getBoundingClientRect().width),
    rects: bars.map((b) => {
      const r = b.getBoundingClientRect()
      return { x: r.x, w: r.width }
    }),
    canvasW: cv?.width ?? 0,
    canvasH: cv?.height ?? 0,
    painted,
    names: [...document.querySelectorAll('.tl-vla-name')].map((n) => n.textContent?.trim()),
    barLeft: document.querySelector('.tl-vla-bar')?.getBoundingClientRect().x ?? -1,
    trackLeft: document.querySelector('.tl-row .tl-bar')?.getBoundingClientRect().x ?? -1,
  }
})
check('时间线出现 5 段指令条', tl.bars === 5, String(tl.bars))
check('指令条带文本', tl.texts.every((t) => t.length > 0), JSON.stringify(tl.texts))
check('指令条宽度按区间成比例（都不是 0）', tl.widths.every((w) => w > 4), JSON.stringify(tl.widths.map((w) => Math.round(w))))
check('两行标题是"指令段 / 动作通道"', tl.names.join('/') === '指令段/动作通道', tl.names.join('/'))
check('canvas 有实际像素尺寸', tl.canvasW > 0 && tl.canvasH > 0, `${tl.canvasW}x${tl.canvasH}`)
check('曲线真的画出来了（非透明像素 > 2000）', tl.painted > 2000, String(tl.painted))
// 帧是"槽位"不是"点"：相邻指令条必须正好相接，否则中间会漏出一道缝，
// 看起来像"这两帧没人标"——而实际上一帧都不缺
check('指令条与轨迹条左端对齐（同一套百分比坐标）',
  Math.abs(tl.barLeft - tl.trackLeft) <= 1, `${Math.round(tl.barLeft)} vs ${Math.round(tl.trackLeft)}`)
check('相邻指令条无缝隙', (() => {
  const gaps = tl.rects.slice(1).map((r, i) => r.x - (tl.rects[i].x + tl.rects[i].w))
  return gaps.every((g) => Math.abs(g) <= 2)
})(), JSON.stringify(tl.rects.slice(1).map((r, i) => Math.round(r.x - (tl.rects[i].x + tl.rects[i].w)))))

// ---- 3. 点指令段 → 跳到首帧 ----
const nav = await page.evaluate(() => {
  const id = window.studio.doc.value.tasks.vla.instructions[3].id
  window.studio.gotoInstruction(id)
  return {
    selected: window.studio.vlaSelectedId.value,
    frame: window.studio.frameNumber(),
    expect: window.studio.doc.value.tasks.vla.instructions[3].startFrame,
  }
})
check('点指令段跳到该段首帧', nav.frame === nav.expect, `${nav.frame} vs ${nav.expect}`)
check('同时选中该段', nav.selected !== null)

// ---- 4. 改区间：命令 → 撤销 → 重做 ----
const edit = await page.evaluate(async () => {
  const t = window.studio.doc.value.tasks.vla
  const seg = t.instructions[1]
  const before = { id: seg.id, start: seg.startFrame, end: seg.endFrame }
  const prevEnd = t.instructions[0].endFrame
  // 起点往后挪 3 帧：故意留一个空档，用来确认"改区间"真的改了文档
  window.studio.editRange(seg.id, seg.startFrame + 3, seg.endFrame)
  await new Promise((r) => setTimeout(r, 120))
  const after = window.studio.doc.value.tasks.vla.instructions.find((s) => s.id === seg.id)
  const gapAfter = window.studio.vlaIssues.value.some((i) => i.code === 'VLA_INSTRUCTION_GAP')
  window.studio.doUndo()
  await new Promise((r) => setTimeout(r, 160))
  const undone = window.studio.doc.value.tasks.vla.instructions.find((s) => s.id === seg.id)
  const gapUndone = window.studio.vlaIssues.value.some((i) => i.code === 'VLA_INSTRUCTION_GAP')
  window.studio.doRedo()
  await new Promise((r) => setTimeout(r, 160))
  const redone = window.studio.doc.value.tasks.vla.instructions.find((s) => s.id === seg.id)
  return {
    before, prevEnd,
    afterStart: after?.startFrame,
    undoneStart: undone?.startFrame,
    redoneStart: redone?.startFrame,
    gapAfter, gapUndone,
  }
})
check('改区间写进文档', edit.afterStart === edit.before.start + 3, `${edit.afterStart} vs ${edit.before.start + 3}`)
check('改区间后校验报出空档（规则跟着数据走）', edit.gapAfter === true)
check('撤销后区间回退', edit.undoneStart === edit.before.start, String(edit.undoneStart))
check('撤销后空档消失', edit.gapUndone === false)
check('重做后区间再次前移', edit.redoneStart === edit.before.start + 3, String(edit.redoneStart))

// ---- 5. 注入错误：规则真的响 ----
const injected = await page.evaluate(async () => {
  // 先清掉前面留下的痕迹：重做一次干净生成
  await window.studio.loadDemo()
  await new Promise((r) => setTimeout(r, 200))
  const clean = window.studio.vlaIssues.value.length
  window.studio.toggleDemoError('sign')
  window.studio.toggleDemoError('gap')
  await window.studio.loadDemo()
  await new Promise((r) => setTimeout(r, 220))
  const codes = window.studio.vlaIssues.value.map((i) => i.code)
  return { clean, codes, errors: window.studio.demoErrors.value.slice() }
})
check('重新生成干净数据仍为 0 问题', injected.clean === 0, String(injected.clean))
check('注入 sign + gap 后两条规则都报', injected.codes.includes('VLA_ACTION_SIGN') && injected.codes.includes('VLA_INSTRUCTION_GAP'), injected.codes.join())
check('注入项记在状态里', injected.errors.length === 2, JSON.stringify(injected.errors))

// 复位到干净数据，后面测导出
await page.evaluate(async () => {
  window.studio.toggleDemoError('sign')
  window.studio.toggleDemoError('gap')
  await window.studio.loadDemo()
  await new Promise((r) => setTimeout(r, 200))
})

// ---- 6. 导出 JSONL ----
const dl = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.evaluate(() => window.studio.exportJsonl()),
]).then(([d]) => d).catch(() => null)
check('导出触发了下载', !!dl, dl ? '' : '没有 download 事件')
if (dl) {
  check('文件名是 .jsonl', /\.jsonl$/.test(dl.suggestedFilename()), dl.suggestedFilename())
  const stream = await dl.createReadStream()
  const chunks = []
  for await (const c of stream) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  check('内容只有一行', text.split('\n').length === 1, String(text.split('\n').length))
  const parsed = JSON.parse(text)
  check('导出的指令数与文档一致', parsed.instructions.length === 5, String(parsed.instructions.length))
  check('导出的通道带 values 数组', Array.isArray(parsed.actions?.steer?.values), JSON.stringify(Object.keys(parsed.actions ?? {})))
  check('导出的区间是 snake_case', typeof parsed.instructions[0].start_frame === 'number')
  check('导出带 hz', parsed.hz === 10, String(parsed.hz))
}

// ---- 7. 面板 ----
await page.getByRole('button', { name: 'VLA', exact: true }).click()
await page.waitForTimeout(250)
const panel = await page.evaluate(() => ({
  sections: [...document.querySelectorAll('.vla-sec')].map((e) => e.textContent?.trim()),
  items: document.querySelectorAll('.vla-item').length,
  chips: [...document.querySelectorAll('.vla-chip')].map((e) => e.textContent?.trim()),
  buttons: [...document.querySelectorAll('.vla-panel button')].map((b) => b.textContent?.trim()),
  issues: [...document.querySelectorAll('.vla-issue')].map((e) => e.textContent?.trim().slice(0, 40)),
}))
check('面板列出 5 条指令', panel.items === 5, String(panel.items))
check('面板有"指令段 / 动作通道 / 对齐校验"三块', panel.sections.length >= 3, JSON.stringify(panel.sections))
check('通道 chip 是四个标准名', ['steer', 'throttle', 'brake', 'speed'].every((n) => panel.chips.includes(n)), JSON.stringify(panel.chips))
check('面板有生成/导入/导出按钮',
  ['生成演示', '导入 JSONL', '导出 JSONL'].every((t) => panel.buttons.includes(t)), JSON.stringify(panel.buttons))
check('干净数据时问题区为空', panel.issues.length === 0, JSON.stringify(panel.issues))

// ---- 8. 清除与撤销 ----
const cleared = await page.evaluate(async () => {
  window.studio.clearVla()
  await new Promise((r) => setTimeout(r, 150))
  const gone = !window.studio.doc.value.tasks.vla
  const bars = document.querySelectorAll('.tl-ins').length
  window.studio.doUndo()
  await new Promise((r) => setTimeout(r, 180))
  const back = !!window.studio.doc.value.tasks.vla
  return { gone, bars, back }
})
check('清除后文档里没有 vla 段', cleared.gone)
check('清除后时间线上的指令条消失', cleared.bars === 0, String(cleared.bars))
check('撤销后 vla 段回来', cleared.back)

check('页面无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' || '))

await browser.close()

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)
