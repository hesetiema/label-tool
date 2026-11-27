#!/usr/bin/env node
/**
 * 分层机器校验 —— 不需要 ESLint，约 80 行。
 *
 * 规则（方案 3.1）：
 *   domain 不得依赖 vue / three / components / viewer / state / adapters / workers / ports
 *   core   不得反向依赖 domain
 *
 * 为什么必须有这条脚本：
 *   "不要 import UI 层"写在文档里，三个月后必然破防。
 *   机器能检查的约定才是约定。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(process.cwd(), 'src')

const FORBIDDEN_IN_DOMAIN = [
  { test: /^vue$/, why: 'domain 不能依赖 Vue' },
  { test: /^three(\/|$)/, why: 'domain 不能依赖 Three.js' },
  { test: /(^|\/)(components|viewer|state|adapters|workers|ports)\//, why: 'domain 不能依赖 UI/适配层' },
]

const FORBIDDEN_IN_CORE = [{ test: /(^|\/)domain\//, why: 'core 不能反向依赖 domain' }]

async function listFiles(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(full)))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g

async function main() {
  const violations = []

  const scan = async (layer, rules) => {
    const dir = join(ROOT, layer)
    for (const file of await listFiles(dir)) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(IMPORT_RE)) {
        const spec = match[1]
        for (const rule of rules) {
          if (rule.test.test(spec)) {
            const line = text.slice(0, match.index).split('\n').length
            violations.push(`${relative(process.cwd(), file)}:${line}  import '${spec}' —— ${rule.why}`)
          }
        }
      }
    }
  }

  await scan('domain', FORBIDDEN_IN_DOMAIN)
  await scan('core', FORBIDDEN_IN_CORE)

  if (violations.length) {
    console.error('分层校验失败：')
    for (const v of violations) console.error(`  ✗ ${v}`)
    process.exit(1)
  }
  console.log('分层校验通过：domain 不依赖 UI，core 不依赖 domain')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
