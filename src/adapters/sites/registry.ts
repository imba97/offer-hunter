import type { JobSiteAdapter } from './types'
import type { SiteId } from '~/logic/types'
import { collectAdapters } from '../collect'
import { siteContentEntryOf } from './site-entry'

/**
 * 完整站点适配器注册表。
 *
 * **新增站点 = 加一个站点目录（`meta.ts` + `index.ts` + `content.ts`；有接口的
 * 再加 `injected.ts`），然后什么都不用改** —— 本文件按目录约定 glob 各站点的
 * `index.ts`，manifest 与后台按同一约定读 `meta.ts`（见 routing.ts）。
 *
 * ⚠ 站点目录可以嵌在**平台目录**下：飞书招聘是「一套前端 + 一家一个子域」，
 *   平台共用逻辑在 `sites/feishu/`，每个租户是它下面的子目录
 *   （`sites/feishu/mediastorm/`）。因此 glob 用 `**` 而不是 `*` ——
 *   站点 id 取**叶子目录名**（`mediastorm`），与构建脚本同一套约定。
 *
 * ⚠ 与 routing.ts / meta.ts 的分工（重要）：
 *   站点 meta.ts          纯数据，后台与构建脚本读它（routing.ts glob 它）
 *   registry.ts（本文件） 完整适配器，只有内容脚本、侧边栏与测试需要
 *
 * 后台**不要** import 本文件：那会把每个站点的选择器与 DOM 代码拖进后台包。
 *
 * ⚠ 本文件不得引用 Vue 组件，各站点适配器的模块顶层也必须保持纯净
 *   （DOM 访问只写在函数体内），否则后台一 import 就会在启动阶段炸。
 *
 * 数组顺序即诊断与提示文案里的展示顺序（按目录路径排序，稳定且可预期）。
 */
export const JOB_SITES: JobSiteAdapter[] = collectAdapters(
  import.meta.glob<{ default: JobSiteAdapter }>('./**/index.ts', { eager: true }),
  /*
   * 平台目录本身不是站点（`sites/feishu/` 没有 index.ts，靠这条约定被排除）。
   * 将来若平台层也冒出 index.ts，按「有没有 meta」过滤更稳。
   */
  { filter: adapter => Boolean(adapter?.meta) },
)

/** 按 id 取站点；未知 id 返回 undefined */
export function getJobSite(id: string): JobSiteAdapter | undefined {
  return JOB_SITES.find(site => site.meta.id === id)
}

/**
 * 内容脚本的构建入口：每个站点一份。
 *
 * 每个站点单独打包（而不是一个大脚本按 URL 分支）的好处是：注入脚本捕获哪些接口
 * 由 manifest 静态决定，各站点的选择器不会互相污染，且新增站点不改变既有站点的
 * 产物。构建配置按**目录约定**独立发现站点（见 scripts/build-sites.ts），
 * 这里保留一份是为了让「已注册站点」这一事实有唯一可读的出处。
 */
export function contentScriptEntries(): Array<{ siteId: string, entry: string, fileName: string }> {
  const entryOf = siteContentEntryOf(Object.keys(import.meta.glob('./**/content.ts')))

  return JOB_SITES.map(site => ({
    siteId: site.meta.id,
    // 理论上必然命中（站点实例就是从同一个目录约定来的）；退回约定路径只是为了让
    // 类型收敛，真出现时 registry.spec 会红
    entry: entryOf.get(site.meta.id) ?? `src/adapters/sites/${site.meta.id}/content.ts`,
    fileName: `${site.meta.id}.global.js`,
  }))
}

export type { JobSiteAdapter, SiteManifestSpec } from './types'
export type { SiteId }
