import type { SiteDescriptor } from './descriptors'
import { hostnameOf, isHostOf } from './descriptors'
import { SITE_DESCRIPTORS } from './site-descriptors'

/**
 * 站点路由：**不依赖任何站点代码**。
 *
 * 后台（service worker）与侧边栏只 import 本文件 —— 它只读纯数据描述，
 * 因此后台包里不会出现选择器与 DOM 代码。
 * 完整的站点适配器在 registry.ts（只有内容脚本与测试需要）。
 */

export { SITE_DESCRIPTORS }
export type { SiteDescriptor }

/** 按 id 取站点描述 */
export function getSiteDescriptor(id: string): SiteDescriptor | undefined {
  return SITE_DESCRIPTORS.find(site => site.id === id)
}

/**
 * URL → 站点描述。
 *
 * 判据是**权威主机名**（等于主域或它的子域），刻意不用 `matches` 的模式串：
 * 模式串是给浏览器 API 用的，表达能力不足以排除 `zhipin.com.evil.com` 这类
 * 形似域名。返回 null 表示不属于任何已支持站点。
 */
export function detectSite(url: string | undefined): SiteDescriptor | null {
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
 * 单站点时是「BOSS 直聘」；多站点时自动变成并列，
 * 因此调用方不必自己拼站点名（那会让每加一个站点都要改文案）。
 */
export function supportedSitesLabel(): string {
  return SITE_DESCRIPTORS.map(site => site.label).join(' / ')
}
