/**
 * ============================================================
 * 浏览器手测：Playwright 解析
 * ============================================================
 *
 * 【为什么不在 devDependencies 里】
 *   playwright 装一次带 200MB 浏览器（虽然本仓库用 `channel: 'msedge'` 复用系统 Edge），
 *   而它只服务于"跑一遍手测"这一件事，不该让每个 `pnpm install` 都付这个代价。
 *   所以这里做三级解析，按便宜到贵：
 *     1. 项目里已有 `playwright`（用户自己 `pnpm add -D playwright` 过）；
 *     2. 环境变量 `PLAYWRIGHT_PATH` 指到别的 node_modules/playwright；
 *     3. `npx playwright` 的缓存目录（跑过一次 `npx playwright` 就有）。
 *
 *   都找不到时给出可执行的提示，而不是抛一个 ERR_MODULE_NOT_FOUND。
 *
 * 【为什么用系统 Edge】
 *   手测要验的正是"用户浏览器里的 IndexedDB / 配额 / WebGL 行为"，
 *   下载一个 Chromium 反而偏离目标；`channel: 'msedge'` 用的是本机 Edge。
 *   headless 下 WebGL 走 SwiftShader，够跑通逻辑（画面精度不在手测范围内）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function candidates() {
  const list = []
  if (process.env.PLAYWRIGHT_PATH) list.push(process.env.PLAYWRIGHT_PATH)

  // 3. npx 缓存：Windows 在 %LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules
  const npxRoots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'),
    join(homedir(), '.npm', '_npx'),
  ].filter(Boolean)
  for (const root of npxRoots) {
    if (!existsSync(root)) continue
    for (const dir of readdirSync(root)) {
      list.push(join(root, dir, 'node_modules', 'playwright', 'index.mjs'))
    }
  }
  return list
}

export async function loadPlaywright() {
  try {
    return await import('playwright')
  } catch { /* 往下找 */ }

  for (const path of candidates()) {
    if (!existsSync(path)) continue
    try {
      return await import(pathToFileURL(path).href)
    } catch { /* 这个候选坏了，继续 */ }
  }

  throw new Error(
    '找不到 playwright。任选一种：\n'
    + '  1. pnpm add -D playwright\n'
    + '  2. npx playwright --version（把包拉到 npx 缓存即可）\n'
    + '  3. 设置 PLAYWRIGHT_PATH 指向其它位置的 playwright/index.mjs',
  )
}

export const LAUNCH_OPTS = {
  // 复用本机 Edge：手测要验的就是真实浏览器的 IndexedDB / 配额行为
  channel: 'msedge',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
}
