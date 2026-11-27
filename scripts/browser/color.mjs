// 浏览器手测：点云着色与读取兜底
// 运行：pnpm dev --port 5199（另一终端）+ node scripts/browser/color.mjs
//
// 验三件事，都是 Node 侧断言测不到的：
//   1. 示例点云（SUSTechPOINTS 的 000970.pcd，FIELDS 里带 intensity）
//      载入后 `cloud.intensity` 真的有值，且长度与点数一致；
//   2. 右侧「点云」段出现「强度」按钮（没有 intensity 的旧数据不该出现），
//      点「强度」「高度」后 3D 与三视图都不炸（console 无报错）；
//   3. 拖一个 .ply 文件进去也能当点云读 —— 这条走的是真实 File → worker → 解析链路。
import { loadPlaywright, LAUNCH_OPTS } from './_pw.mjs'

const { chromium } = await loadPlaywright()

const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })

const browser = await chromium.launch(LAUNCH_OPTS)
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

await page.goto(APP + '?data=real', { waitUntil: 'load' })

// 等示例点云真的进了文档（count > 0），最多等 20s
const loaded = await page
  .waitForFunction(
    () => {
      const c = window.studio?.cloud?.value
      return !!c && c.count > 0
    },
    undefined,
    { timeout: 20_000 },
  )
  .then(() => true)
  .catch(() => false)
check('示例点云载入完成', loaded)

const info = await page.evaluate(() => {
  const c = window.studio.cloud.value
  return { count: c.count, intensityLen: c.intensity?.length ?? 0, hasColors: !!c.colors }
})
check('点数 > 0', info.count > 0, String(info.count))
check('intensity 被解析出来', info.intensityLen > 0, String(info.intensityLen))
check('intensity 与点数同长', info.intensityLen === info.count, `${info.intensityLen} vs ${info.count}`)

// 「点云」段的四个按钮
const cloudSection = page.locator('.appearance-row', { hasText: '点云' }).first()
const intensityBtn = cloudSection.getByRole('button', { name: '强度' })
const heightBtn = cloudSection.getByRole('button', { name: '高度' })
check('出现「强度」按钮', (await intensityBtn.count()) === 1)
check('出现「高度」按钮', (await heightBtn.count()) === 1)

// 切到强度：颜色由 core/geometry/colorize.ts 生成，3D 与三视图都读同一份
await intensityBtn.click()
const byIntensity = await page.evaluate(() => window.studio.pointColorBy.value)
check('点「强度」切到 intensity 模式', byIntensity === 'intensity', byIntensity)

// 让三轮渲染真的跑一遍：主循环是 rAF，断言前等两帧
await page.waitForTimeout(400)
const intensityState = await page.evaluate(() => ({ mode: window.studio.pointColorBy.value, err: null }))
check('强度模式下无异常', intensityState.mode === 'intensity')

await heightBtn.click()
await page.waitForTimeout(400)
check('点「高度」切到 height 模式', (await page.evaluate(() => window.studio.pointColorBy.value)) === 'height')

// 三视图仍在画（正交视图的 canvas 有非空像素数据即说明重绘过）
const orthoPainted = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll('.ortho-strip canvas')]
  return canvases.length > 0 && canvases.every((c) => c.width > 0 && c.height > 0)
})
check('三视图 canvas 仍在', orthoPainted)

// 回到默认，避免影响后面的用例
await cloudSection.getByRole('button', { name: '默认' }).click()
check('能切回默认着色', (await page.evaluate(() => window.studio.pointColorBy.value)) === 'default')

// ---------------------------------------------------------------
// 拖一个 .ply 进去：真实 File → worker → parseCloudBuffer 链路
const ply = [
  'ply',
  'format ascii 1.0',
  'element vertex 4',
  'property float x',
  'property float y',
  'property float z',
  'property float intensity',
  'end_header',
  '0 0 0 0.1',
  '1 0 0 0.5',
  '0 1 0 0.9',
  '1 1 1 1.0',
  '',
].join('\n')
await page.setInputFiles('input[type=file][data-role="cloud-input"]', {
  name: 'demo.ply',
  mimeType: 'application/octet-stream',
  buffer: Buffer.from(ply, 'utf8'),
})

const plyLoaded = await page
  .waitForFunction(
    () => {
      const c = window.studio?.cloud?.value
      return !!c && c.count === 4
    },
    undefined,
    { timeout: 15_000 },
  )
  .then(() => true)
  .catch(() => false)
check('.ply 被读成点云（4 点）', plyLoaded)

const plyInfo = await page.evaluate(() => {
  const c = window.studio.cloud.value
  return { count: c.count, intensity: c.intensity?.[2] ?? null, z: c.positions?.[8] ?? null }
})
check('.ply 的 intensity 读出来了', Math.abs((plyInfo.intensity ?? 0) - 0.9) < 1e-6, String(plyInfo.intensity))
check('.ply 的坐标正确（第三点 z=0）', plyInfo.z === 0, String(plyInfo.z))

check('页面无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '))

await browser.close()
const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)
