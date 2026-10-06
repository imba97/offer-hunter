import type { SiteMeta } from '../src/adapters/sites/types'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertUniqueSiteIds } from '../src/adapters/sites/site-entry'
import { buildSiteMetas } from '../src/adapters/sites/site-metas'
import { r } from './utils'

/**
 * 在 Node 侧扫出各站点的纯数据描述，供 manifest 生成器使用。
 *
 * ── 为什么 Node 侧要自己扫一遍 ──────────────────────────────────────────
 * 运行时（后台 / 侧边栏）与单测里的站点清单来自 `import.meta.glob`，那是
 * **Vite 的编译期特性**：只有经过 Vite 处理的代码里才有它。而 manifest 生成器
 * （`scripts/manifest.ts`）由 esno 直接跑在 Node 里，那里 `import.meta.glob`
 * 根本不存在（真机报 `... .glob is not a function`）。所以这一层必须自己扫目录。
 *
 * ⚠ 扫完**直接返回**，不落任何中间文件：清单只被同一次进程里的下一步
 *   （`writeManifest`）用一次，写成 JSON 再读回来是纯粹的多余步骤。
 *
 * 两份扫描（Vite 的 glob 与这里的目录遍历）不会分叉，靠两条约束：
 *   1. 聚合（排序 + 取值）共用 `buildSiteMetas()`，与 Vite 侧是同一份实现
 *   2. `src/adapters/sites/__tests__/siteEntry.spec.ts` 钉住：这里扫出来的
 *      id 集合必须与 Vite glob 的 id 集合完全一致（不一致测试就红）
 */

const SITES_DIR = r('src/adapters/sites')

/**
 * 递归找出所有站点描述文件，返回相对 `SITES_DIR` 的 glob 形状路径（`./<相对路径>`）。
 *
 * 形状刻意与 Vite glob 的键一致，这样两边交给 `buildSiteMetas()` 的东西是同构的。
 *
 * ⚠ 站点可以嵌在平台目录下（`sites/feishu/<公司>/meta.ts`），所以递归；
 *   下划线开头的目录（`__tests__`）跳过，与构建脚本的约定一致。
 */
async function findMetaFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.'))
      continue

    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...await findMetaFiles(resolve(dir, entry.name), relative))
      continue
    }
    if (entry.name === 'meta.ts')
      files.push(`./${relative}`)
  }

  return files
}

/**
 * 扫描并返回站点描述（不落盘）。
 *
 * 顺序由 `buildSiteMetas()` 决定，与扩展运行时那份一致 —— manifest 里的站点顺序
 * 因此不会与侧边栏按钮、诊断列表的顺序分叉。
 */
export async function scanSiteDescriptors(): Promise<SiteMeta[]> {
  const modules: Record<string, { default: SiteMeta }> = {}

  for (const key of await findMetaFiles(SITES_DIR)) {
    const mod = await import(pathToFileURL(resolve(SITES_DIR, key)).href) as { default: SiteMeta }
    modules[key] = mod
  }

  const descriptors = buildSiteMetas(modules)

  // id 重复会让按 id 查表静默取到前一个，这里当场炸掉
  assertUniqueSiteIds(descriptors)

  return descriptors
}
