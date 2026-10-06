import type { JobSiteAdapter } from './types'
import { bossSite } from './boss'
import { eleduckSite } from './eleduck'
import { mediastormSite } from './feishu/mediastorm'
import { v2exSite } from './v2ex'

/**
 * 完整站点适配器注册表。
 *
 * **新增一个站点 = 加一个 `sites/<id>/`（或平台下的 `sites/<平台>/<id>/`）目录
 * + 在 site-descriptors.ts 加一项 + 在下面加一行。** 构建（scripts/ 与两个 vite
 * 配置）、内容脚本入口、侧边栏、后台都从这几处派生，因此都不需要改。
 *
 * ⚠ 与 routing.ts / site-descriptors.ts 的分工（重要）：
 *   site-descriptors.ts  纯数据，后台与构建脚本读它
 *   routing.ts           数据驱动的路由（认站点、匹配模式、文案）
 *   registry.ts（本文件）完整适配器，只有内容脚本、侧边栏与测试需要
 *
 * 后台**不要** import 本文件：那会把每个站点的选择器与 DOM 代码拖进后台包。
 *
 * ⚠ 本文件不得引用 Vue 组件，各站点适配器的模块顶层也必须保持纯净
 *   （DOM 访问只写在函数体内），否则后台一 import 就会在启动阶段炸。
 *
 * 数组顺序即诊断与提示文案里的展示顺序。
 */
export const JOB_SITES: JobSiteAdapter[] = [
  bossSite,
  eleduckSite,
  v2exSite,
  /*
   * 影视飓风（飞书招聘的租户）。它与其他三家一样是「一个目录 = 一个站点」，
   * 只是嵌在平台目录 `feishu/` 下：平台共用逻辑在上一级，公司配置在同级
   * （见 feishu/mediastorm/index.ts）。
   *
   * 同一平台下的下一家公司照抄这一行即可 —— 与上面三家没有任何形式上的差别，
   * 也正因为如此，这里不需要「按目录自动发现站点」那类魔法。
   */
  mediastormSite,
]

/** 按 id 取站点；未知 id 返回 undefined */
export function getJobSite(id: string): JobSiteAdapter | undefined {
  return JOB_SITES.find(site => site.id === id)
}

/**
 * 内容脚本的构建入口：每个站点一份。
 *
 * 每个站点单独打包（而不是一个大脚本按 URL 分支）的好处是：注入脚本捕获哪些接口
 * 由 manifest 静态决定，各站点的选择器不会互相污染，且新增站点不改变既有站点的
 * 产物。构建配置按**目录约定**独立发现站点（见 scripts/build-sites.ts），
 * 这里保留一份是为了让「已注册站点」这一事实有唯一可读的出处。
 *
 * ⚠ 站点可以嵌在平台目录下（`sites/feishu/mediastorm/`），所以入口路径不能靠
 *   `sites/<id>/content.ts` 拼出来 —— 那份映射由目录约定（glob）给出。
 *   产物名仍然只取站点 id：`dist/contentScripts/<id>.global.js`。
 */
export function contentScriptEntries(): Array<{ siteId: string, entry: string, fileName: string }> {
  const entryOf = new Map<string, string>()
  for (const path of Object.keys(import.meta.glob('./**/content.ts'))) {
    // 站点目录本身可能嵌在平台目录下（sites/feishu/mediastorm/），因此站点 id 取
    // 文件名上一级的目录名，而不是「路径里固定的第几段」
    const relative = path.replace(/^\.\//, '').replace(/\/content\.ts$/, '')
    const id = relative.split('/').pop()
    if (id)
      entryOf.set(id, `src/sites/${relative}/content.ts`)
  }

  return JOB_SITES.map(site => ({
    siteId: site.id,
    // 理论上必然命中（站点实例就是从同一个目录约定来的）；退回约定路径只是为了让
    // 类型收敛，真出现时 registry.spec 会红
    entry: entryOf.get(site.id) ?? `src/sites/${site.id}/content.ts`,
    fileName: `${site.id}.global.js`,
  }))
}

export type { JobSiteAdapter, SiteId, SiteManifestSpec } from './types'
