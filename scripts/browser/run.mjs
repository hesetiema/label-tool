/**
 * ============================================================
 * 浏览器手测总入口
 * ============================================================
 *
 *   node scripts/browser/run.mjs            # 跑全部
 *   node scripts/browser/run.mjs gc load    # 只跑指定几支
 *
 * 为什么这些用例不并进 `pnpm test`：
 *   它们要真实 IndexedDB（事务、游标、配额）、真实 WebGL、真实文件选择，
 *   Node 里全都测不到；而且每次要跑十几秒到几分钟，塞进提交前的单测会让人绕过测试。
 *   所以定位是"改到存储 / 懒加载 / 时间线之后手跑一遍"。
 *
 * 前置：另开一个终端 `pnpm dev`（默认 5199），或设 APP_URL 指向已起的实例。
 * 浏览器：复用本机 Edge（见 _pw.mjs），不需要 `playwright install`。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'

const SUITES = {
  gc: 'GC 判定矩阵（控制台入口、dryRun、四类判定、启动清扫）',
  load: '懒加载端到端（21 帧导入、逐帧落盘、刷新恢复）',
  timeline: '时间线拖拽 / 右键菜单 / 合并保存 / 三个导出入口',
  docfirst: 'doc-first 恢复（点云外置、生命周期保真、只剩文档、清草稿）',
  collide: '两个同帧数数据集不撞号',
  crosstab: '跨标签页协调（租约只读 / 接管 / 引用广播 / 回收审计）',
  library: '本地样本列表（浏览 / 删除判定 / 落盘删除 / 对端持有拒绝）',
  lru: '帧缓存淘汰（预算 / 保护邻域 / 整帧进出 / 审计）',
  evict: '全局淘汰与 LFU（跨数据集 / 跨标签页通知 / 对端保护键 / 策略切换）',
  p2: '预标注与复核（跑模型 / 合并 / 复核队列 / 快捷键 / 导出闸门 / 冲突）',
}

const picked = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const names = picked.length ? picked : Object.keys(SUITES)
for (const n of names) {
  if (!SUITES[n]) {
    console.error(`未知用例：${n}\n可用：${Object.keys(SUITES).join(', ')}`)
    process.exit(2)
  }
}

async function reachable(url) {
  try {
    const res = await fetch(url, { method: 'GET' })
    return res.ok
  } catch {
    return false
  }
}

if (!(await reachable(APP))) {
  console.error(`连不上 ${APP}\n先另开终端跑 \`pnpm dev --port 5199\`，或用 APP_URL 指定地址。`)
  process.exit(2)
}

const run = (name) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(HERE, `${name}.mjs`)], {
    cwd: HERE,
    stdio: 'inherit',
    env: { ...process.env, APP_URL: APP },
  })
  child.on('exit', (code) => resolve(code ?? 1))
})

const failed = []
for (const name of names) {
  console.log(`\n──────── ${name}：${SUITES[name]} ────────`)
  const code = await run(name)
  if (code !== 0) failed.push(name)
}

console.log(`\n${'='.repeat(52)}`)
if (failed.length) {
  console.log(`失败 ${failed.length}/${names.length} 支：${failed.join(', ')}`)
  process.exit(1)
}
console.log(`全部通过（${names.length} 支）`)
