/**
 * 站点的**纯数据描述**（路由所需的最小信息）。
 *
 * 与 registry.ts 分开是一个刻意的边界：
 *
 *   descriptors.ts  纯数据：id / 名字 / 职位页 / 匹配哪些地址 / 是不是自家域名
 *   registry.ts     完整适配器：选择器、DOM 读取、接口翻译、诊断
 *
 * 后台（service worker）只需要前者 —— 它要判断标签页属于哪个站点、跳去哪、
 * 怎么按地址查标签页。若它 import 注册表，就会把每个站点的 DOM 代码与选择器
 * 一起拖进后台包（实测确实会，`querySelector` 出现在后台产物里）。
 *
 * 因此**后台一律 import 本文件**；只有内容脚本、侧边栏与测试才碰 registry.ts。
 *
 * URL 匹配也放在这里，且是**数据驱动的**（匹配模式 + 主机名），不是每个站点
 * 写一个谓词函数：这样后台判断「是不是我们的站点」时不必加载任何站点代码。
 */

export interface SiteDescriptor {
  /**
   * 站点标识。必须与 `src/sites/<id>/` 目录名一致 ——
   * 构建配置按目录约定生成产物路径，两者对不上就会出现「构建成功但注入不生效」。
   */
  id: string
  /** 展示用名字 */
  label: string
  /** 用户不在此站点时，点图标跳去的地址；也是侧边栏「打开职位页」按钮的目标 */
  jobsPageUrl: string
  /**
   * 取数方式（与适配器的 `source` 同源）。
   *
   * manifest 生成时读它：只有 `'api'` 的站点才注入 MAIN world 脚本 ——
   * DOM-only 的站点没有任何接口要被捕获，挂 hook 是纯侵入。
   */
  source: 'api' | 'dom'
  /**
   * 平台主色（十六进制）。侧边栏「打开职位页」按钮用它做背景，
   * 让用户一眼分得清哪个按钮通向哪家。取自各平台自身的品牌色。
   */
  color: string
  /**
   * 主色上的文字颜色。
   *
   * 显式声明而不是按亮度算：品牌色有亮有暗（电鸭 #f9ba48 偏亮、BOSS #00bebd 偏深），
   * 算法给出的对比度未必是设计上最舒服的那个，配置永远可以覆盖它。
   */
  textColor: string
  /** 该站点适配器声明的匹配模式（与 manifest 的 matches 同源） */
  matches: string[]
  /**
   * 权威主机名，用于精确判断一个具体 URL 是否属于本站点。
   *
   * 与 `matches` 分开而不是从它反解：manifest 的模式串表达能力有限
   * （`*://*.zhipin.com/*`），而精确匹配要求「域名恰为 zhipin.com 或其子域」，
   * 不能用后缀 includes（`zhipin.com.evil.com` 会被误判为自家站点）。
   */
  hostnames: string[]
}

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
