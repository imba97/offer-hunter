import type { SiteDescriptor } from './descriptors'

/**
 * 各站点的纯数据描述。**新增站点 = 加一个 sites/<id>/ 目录 + 在这里加一项。**
 *
 * 只有数据、没有代码，所以后台可以安全 import（见 descriptors.ts 的说明）。
 *
 * ⚠ 每个站点的 `id` 必须与 `src/sites/<id>/` 目录名一致：构建配置按目录约定
 *   生成产物路径（dist/injected/<id>.js、dist/contentScripts/<id>.global.js），
 *   两者对不上会表现成「构建成功但脚本没注入」。
 */

/*
 * BOSS 的常量单独导出：站点适配器（sites/boss/index.ts）要复用同一份值。
 * 拆成两份字面量的话，改了这里忘了那里就会出现「后台认这个域名、内容脚本不认」
 * 的自相矛盾状态 —— 那类 bug 很难查，因为两侧各自看起来都对。
 */
export const BOSS_SITE_ID = 'boss'
export const BOSS_MATCHES = ['*://*.zhipin.com/*']
export const BOSS_HOSTNAMES = ['zhipin.com']

export const SITE_DESCRIPTORS: SiteDescriptor[] = [
  {
    id: BOSS_SITE_ID,
    label: 'BOSS 直聘',
    jobsPageUrl: 'https://www.zhipin.com/web/geek/jobs',
    matches: BOSS_MATCHES,
    hostnames: BOSS_HOSTNAMES,
  },
]
