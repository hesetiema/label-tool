/**
 * 手测夹具：把 public/data 里的样例点云复制成"多帧序列"。
 *
 * 为什么复制而不是直接用 `?data=sequence`：
 *   手测要验的是「选 21 个文件 → 懒加载 → 逐帧落盘 → 刷新恢复」这条真实路径，
 *   而程序化演示序列没有文件、也没有数据集键，走不到那条分支。
 *
 * 目录放在系统临时目录下，按 tag 分开（A/B 用不同文件名前缀，
 * 才能在"两个同帧数数据集不撞号"的用例里得到不同的 datasetKey）。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA = fileURLToPath(new URL('../../public/data/', import.meta.url))

function stemOf(tag, i) {
  // A 组用 000001.. / B 组用 100001..，保证 datasetKey 不同
  return tag === 'A' ? String(i).padStart(6, '0') : String(100000 + i)
}

/**
 * 准备 n 帧「点云 + 同名标注」文件。
 * @returns {{ dir: string, files: string[] }} files 是可直接喂给 setInputFiles 的绝对路径
 */
export function ensureSequence(tag = 'A', count = 21) {
  const dir = join(tmpdir(), `label-tool-fixture-${tag}`)
  const first = join(dir, `${stemOf(tag, 1)}.pcd`)
  if (!existsSync(first)) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    for (let i = 1; i <= count; i++) {
      const stem = stemOf(tag, i)
      copyFileSync(join(DATA, '000970.pcd'), join(dir, `${stem}.pcd`))
      copyFileSync(join(DATA, '000970.json'), join(dir, `${stem}.json`))
    }
  }
  const files = []
  for (let i = 1; i <= count; i++) {
    const stem = stemOf(tag, i)
    files.push(join(dir, `${stem}.pcd`), join(dir, `${stem}.json`))
  }
  return { dir, files }
}
