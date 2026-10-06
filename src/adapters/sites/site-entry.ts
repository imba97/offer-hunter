import type { SiteMeta } from './types'

/**
 * 构建脚本与注册表共用的**目录约定解析**。
 *
 * 站点、平台、简历来源三处都是「按目录约定自动索引」，而解析这件事在三处各写过
 * 一遍：从 glob 键（`./boss/index.ts`）或文件系统路径（`boss/index.ts`）里取站点 id
 * （叶子目录名）、判断该站点有没有注入脚本入口。三份实现里任何一份写歪，症状都是
 * 「某个站点静默不生效」——**静默**是这里最贵的属性，所以收敛成一份并配单测。
 *
 * ⚠ 这些函数**不依赖 Vite 也不依赖 Node**：构建脚本（Node）与注册表（Vite）
 *   都 import 它，因此它只能做纯字符串处理。
 */

/**
 * 站点目录里**参与目录约定**的四个文件名：一个站点由它们构成。
 *
 * 只有这几个文件能用来取站点 id —— 别的文件（`selectors.ts` / `api.ts`…）是站点
 * 私有实现，拿它们推 id 只会推出一个不存在的站点（症状是「索引里多了一个站点、
 * 或者本该在的站点没了」，都是静默的）。
 */
const ENTRY_FILE = /\/(?:index|meta|content|injected)\.ts$/

/**
 * 从路径里取站点 id：叶子目录名（`feishu/mediastorm/index.ts` → `mediastorm`）。
 *
 * 路径不以约定文件结尾时返回空串（调用方据此跳过），不做「猜一个」。
 */
export function siteIdFromPath(path: string): string {
  const normalized = path.replace(/^\.\//, '').replace(/^src\/sites\//, '')
  const dir = ENTRY_FILE.test(normalized) ? normalized.replace(ENTRY_FILE, '') : ''
  return dir.split('/').pop() ?? ''
}

/** 把 glob 键（`./boss/index.ts`）转成相对 `src/adapters/sites` 的路径（`boss/index.ts`） */
export function siteRelativePath(globKey: string): string {
  return globKey.replace(/^\.\//, '')
}

/**
 * 站点 id → 它的内容脚本入口（相对 `src/adapters/sites` 的路径）。
 *
 * 站点目录可以嵌在平台目录下（`feishu/mediastorm/content.ts`），因此入口路径不能靠
 * `sites/<id>/content.ts` 拼出来，必须由目录约定给出。
 */
export function siteContentEntryOf(globKeys: string[]): Map<string, string> {
  const entries = new Map<string, string>()

  for (const key of globKeys) {
    if (!key.endsWith('/content.ts'))
      continue
    const relative = siteRelativePath(key).replace(/\/content\.ts$/, '')
    const id = siteIdFromPath(key)
    if (id)
      entries.set(id, `src/adapters/sites/${relative}/content.ts`)
  }

  return entries
}

/** 站点 id → 它的注入脚本入口（相对 `src/adapters/sites` 的路径）；没有 injected.ts 的站点不在其中 */
export function siteInjectedEntryOf(globKeys: string[]): Map<string, string> {
  const entries = new Map<string, string>()

  for (const key of globKeys) {
    if (!key.endsWith('/injected.ts'))
      continue
    const relative = siteRelativePath(key).replace(/\/injected\.ts$/, '')
    const id = siteIdFromPath(key)
    if (id)
      entries.set(id, `src/adapters/sites/${relative}/injected.ts`)
  }

  return entries
}

/** 站点 id 唯一性检查（重复会让按 id 查表静默取到前一个） */
export function assertUniqueSiteIds(metas: SiteMeta[]): void {
  const seen = new Set<string>()
  for (const meta of metas) {
    if (seen.has(meta.id))
      throw new Error(`站点 id 重复：${meta.id}（两处 meta.ts 声明了同一个 id）`)
    seen.add(meta.id)
  }
}
