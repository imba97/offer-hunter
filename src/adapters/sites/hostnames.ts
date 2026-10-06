/**
 * 主机名判定：站点归属与路由共用的两个纯函数。
 *
 * 单独一个文件（而不是塞进 routing.ts 或 descriptors.ts）的理由：它**既被后台读**
 * （routing.ts 用它做标签页路由），**也被各站点适配器读**（`matchUrl` 用同一套判定）。
 * 站点适配器不能 import routing.ts，否则「适配器 → 路由 → 全部站点的 meta」会绕成
 * 一个环，而且会把所有站点的描述拖进每个内容脚本的产物里。
 */

/**
 * 主域名匹配：等于自身或它的子域。
 *
 * 刻意不用 `host.endsWith('zhipin.com')`：那样 `zhipin.com.evil.com` 也会命中。
 */
export function isHostOf(hostname: string, domains: string[]): boolean {
  const host = hostname.toLowerCase()
  return domains.some((domain) => {
    const d = domain.toLowerCase()
    return host === d || host.endsWith(`.${d}`)
  })
}

/** 从 URL 里取主机名；拿不到返回空串（标签页可能还没加载完） */
export function hostnameOf(url: string | undefined): string {
  if (!url)
    return ''
  try {
    return new URL(url).hostname
  }
  catch {
    return ''
  }
}
