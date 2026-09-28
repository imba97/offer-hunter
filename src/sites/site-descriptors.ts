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
 * 各站点的常量单独导出：站点适配器（sites/<id>/index.ts）与内容脚本入口要复用
 * 同一份值。拆成两份字面量的话，改了这里忘了那里就会出现「后台认这个域名、
 * 内容脚本不认」的自相矛盾状态 —— 那类 bug 很难查，因为两侧各自看起来都对。
 */
export const BOSS_SITE_ID = 'boss'
export const BOSS_MATCHES = ['*://*.zhipin.com/*']
export const BOSS_HOSTNAMES = ['zhipin.com']
export const BOSS_JOBS_PAGE_URL = 'https://www.zhipin.com/web/geek/jobs'

export const ELEDUCK_SITE_ID = 'eleduck'
export const ELEDUCK_MATCHES = ['*://*.eleduck.com/*']
export const ELEDUCK_HOSTNAMES = ['eleduck.com']
/*
 * 只是**列表**地址：拿岗位内容仍然要到具体的帖子页（/posts/<slug>）。
 * 这一点已在侧边栏的空状态文案里说明（「先打开职位列表，再点开岗位」）。
 */
export const ELEDUCK_JOBS_PAGE_URL = 'https://eleduck.com/jobs-channel'

export const SITE_DESCRIPTORS: SiteDescriptor[] = [
  {
    id: BOSS_SITE_ID,
    label: 'BOSS 直聘',
    jobsPageUrl: BOSS_JOBS_PAGE_URL,
    // 岗位数据来自 /wapi/zpgeek/… 接口（注入脚本被动捕获）
    source: 'api',
    color: '#00bebd',
    textColor: '#ffffff',
    matches: BOSS_MATCHES,
    hostnames: BOSS_HOSTNAMES,
  },
  {
    id: ELEDUCK_SITE_ID,
    label: '电鸭社区',
    jobsPageUrl: ELEDUCK_JOBS_PAGE_URL,
    // 站点对非浏览器请求会返回验证页，因此没有可用的接口，只读 DOM
    source: 'dom',
    color: '#f9ba48',
    // 主色偏亮，用深色字才看得清
    textColor: '#3d2f0b',
    matches: ELEDUCK_MATCHES,
    hostnames: ELEDUCK_HOSTNAMES,
  },
]
