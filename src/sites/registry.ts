import type { JobSiteAdapter } from './types'
import { bossSite } from './boss'

/**
 * 完整站点适配器注册表。
 *
 * **新增一个站点 = 加一个 sites/<id>/ 目录 + 在 site-descriptors.ts 加一项
 * + 在下面加一行。** 构建（scripts/ 与两个 vite 配置）、内容脚本入口、
 * 侧边栏、后台都从这几处派生，因此都不需要改。
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
 * 产物。构建配置按**目录约定**独立发现站点（见 vite.config.content.mts），
 * 这里保留一份是为了让「已注册站点」这一事实有唯一可读的出处。
 */
export function contentScriptEntries(): Array<{ siteId: string, entry: string, fileName: string }> {
  return JOB_SITES.map(site => ({
    siteId: site.id,
    entry: `src/sites/${site.id}/content.ts`,
    fileName: `${site.id}.global.js`,
  }))
}

export type { JobSiteAdapter, SiteId, SiteManifestSpec } from './types'
