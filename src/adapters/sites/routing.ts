import type { SiteMetaModules } from './site-metas'
import type { SiteMeta } from './types'
import { hostnameOf, isHostOf } from './hostnames'
import { buildSiteMetas } from './site-metas'

/**
 * 站点路由：**不依赖任何站点代码**。
 *
 * 后台（service worker）与侧边栏只 import 本文件 —— 它只 glob 各站点的
 * `meta.ts`（纯数据），因此后台包里不会出现选择器与 DOM 代码。
 * 完整的站点适配器在 registry.ts（只有内容脚本、侧边栏与测试需要）。
 */

/**
 * 全部站点描述，**按目录约定自动索引**：`sites/**\/meta.ts`。
 *
 * 这就是「新增站点不用改这里」的全部实现：加 `sites/<id>/meta.ts` 就会被收进来。
 * 聚合逻辑（排序与取值）在 site-metas.ts —— scripts/ 侧没有 Vite 的 glob，
 * 但需要**同一份**列表来生成 manifest，两边共用那个函数。
 */
export const SITE_DESCRIPTORS: SiteMeta[] = buildSiteMetas(
  import.meta.glob<{ default: SiteMeta }>('./**/meta.ts', { eager: true }) as SiteMetaModules,
)

/** 按 id 取站点描述 */
export function getSiteDescriptor(id: string): SiteMeta | undefined {
  return SITE_DESCRIPTORS.find(site => site.id === id)
}

export { hostnameOf, isHostOf }

/**
 * URL → 站点描述。
 *
 * 判据是**权威主机名**（等于主域或它的子域），刻意不用 `matches` 的模式串：
 * 模式串是给浏览器 API 用的，表达能力不足以排除 `zhipin.com.evil.com` 这类
 * 形似域名。返回 null 表示不属于任何已支持站点。
 */
export function detectSite(url: string | undefined): SiteMeta | null {
  const host = hostnameOf(url)
  if (!host)
    return null
  return SITE_DESCRIPTORS.find(site => isHostOf(host, site.hostnames)) ?? null
}

/** 所有站点要匹配的地址模式，供 manifest 的 host_permissions 与 content_scripts 使用 */
export function siteMatches(): string[] {
  return SITE_DESCRIPTORS.flatMap(site => site.matches)
}

/**
 * 用户不在任何支持站点时的提示文案。
 *
 * 由各站点描述的名字并列拼出（如「BOSS 直聘 / 电鸭社区」），
 * 因此调用方不必自己拼站点名 —— 那会让每加一个站点都要改文案。
 */
export function supportedSitesLabel(): string {
  return SITE_DESCRIPTORS.map(site => site.label).join(' / ')
}

export type { SiteMeta } from './types'
