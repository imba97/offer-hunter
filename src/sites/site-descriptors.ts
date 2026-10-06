import type { SiteDescriptor } from './descriptors'
import type { FeishuAtsTenant } from './feishu/tenants'
import { FEISHU_ATS_TENANTS, getFeishuAtsTenant, tenantHostname, tenantJobsPageUrl } from './feishu/tenants'

/**
 * 各站点的纯数据描述。**新增站点 = 加一个 sites/<id>/ 目录 + 在这里加一项。**
 *
 * 只有数据、没有代码，所以后台可以安全 import（见 descriptors.ts 的说明）。
 *
 * ⚠ 每个站点的 `id` 必须与 `src/sites/<id>/` 目录名一致：构建配置按目录约定
 *   生成产物路径（dist/injected/<id>.js、dist/contentScripts/<id>.global.js），
 *   两者对不上会表现成「构建成功但脚本没注入」。
 *
 * ⚠ 一处例外：**飞书招聘的租户**（见底下 `FEISHU_ATS_TENANTS`）由租户表派生。
 *   它们的适配器实例在 `feishu/site.ts` 里按同一张表生成，入口目录是
 *   `sites/feishu/<公司>/`（构建按目录约定发现入口），所以「加一行 + 建一个目录」
 *   这个契约没有被绕过，只是描述与适配器都不用再手写一遍。
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

export const V2EX_SITE_ID = 'v2ex'
/*
 * 两个域名族：v2ex.com 是主站（含 www），v2ex.co 是官方备用域名
 * （搜索结果与部分地区的跳转都落在 global.v2ex.co）。
 */
export const V2EX_MATCHES = ['*://*.v2ex.com/*', '*://*.v2ex.co/*']
export const V2EX_HOSTNAMES = ['v2ex.com', 'v2ex.co']
/*
 * 「酷工作」节点页。同样只是**列表**地址：拿岗位内容要到具体的帖子页
 * （/t/<id>），且只认发在这个节点下的帖子。
 */
export const V2EX_JOBS_PAGE_URL = 'https://www.v2ex.com/go/jobs'

/*
 * 影视飓风是**飞书招聘（ATS）**上的一个租户：它的招聘页跑在该平台上，主机名因此是
 * 租户子域而不是自家域名。刻意只认这一个子域，不放行整个 `*.jobs.feishu.cn` ——
 * 那等于申请一个能读该平台上所有公司招聘页的主机权限
 * （理由见 sites/feishu/tenants.ts 的文件头）。
 *
 * ⚠ 下面这几个常量是**从租户表推导**的，不是另写一份字面量：租户表是这几项的
 *   唯一来源，否则「改了租户表忘了描述表」就会出现「后台认这个域名、租户表说另一个」
 *   这种自相矛盾的状态（而两侧各自看起来都对）。
 */
const MEDIASTORM_TENANT = getFeishuAtsTenant('mediastorm')

if (!MEDIASTORM_TENANT) {
  // 编码错误（租户表里删了它却忘了改这里），当场炸掉比静默生成一堆 undefined 好
  throw new Error('租户表里没有 mediastorm：site-descriptors.ts 与 feishu/tenants.ts 不一致')
}

export const MEDIASTORM_SITE_ID = MEDIASTORM_TENANT.id
export const MEDIASTORM_MATCHES = [`*://${tenantHostname(MEDIASTORM_TENANT)}/*`]
export const MEDIASTORM_HOSTNAMES = [tenantHostname(MEDIASTORM_TENANT)]
/*
 * 社招官网的职位列表页。与电鸭 / V2EX 一样，这里只是**列表**地址：
 * 拿岗位内容要到具体的详情页（`/index/position/<id>/detail`）。
 */
export const MEDIASTORM_JOBS_PAGE_URL = tenantJobsPageUrl(MEDIASTORM_TENANT)

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
  {
    id: V2EX_SITE_ID,
    label: 'V2EX',
    jobsPageUrl: V2EX_JOBS_PAGE_URL,
    // 帖子正文由服务端直接渲染进 HTML，页面自己不调详情接口，因此只读 DOM
    source: 'dom',
    /*
     * V2EX 的「灰蓝」主色（人工选定，不取自站内色板）：V2EX 自身没有品牌蓝，
     * 全站唯一的贯穿色是站点头部那条 #778087，而它偏浅、当按钮底色不够沉。
     * 取更深的 #444455，白色文字在其上的对比度约 9.2:1。
     */
    color: '#444455',
    textColor: '#ffffff',
    matches: V2EX_MATCHES,
    hostnames: V2EX_HOSTNAMES,
  },
  {
    id: MEDIASTORM_SITE_ID,
    label: MEDIASTORM_TENANT.label,
    jobsPageUrl: MEDIASTORM_JOBS_PAGE_URL,
    // 岗位详情有一份公开 JSON 接口（注入脚本被动捕获 + 内容脚本主动补拉）
    source: 'api',
    // 配色也来自租户表，不在这里再写一份色值
    color: MEDIASTORM_TENANT.color,
    textColor: MEDIASTORM_TENANT.textColor,
    matches: MEDIASTORM_MATCHES,
    hostnames: MEDIASTORM_HOSTNAMES,
  },
  /*
   * 飞书招聘的其余租户由租户表派生：加一家公司只需在 feishu/tenants.ts 加一行
   * （同时建一个 feishu/<公司>/ 入口目录），这里与 manifest、后台、侧边栏都不用改。
   * 影视飓风是租户表里的第一家，已在上面显式列出（它与其他三家老站点并列，
   * 便于一眼看见），这里跳过它以免重复。
   *
   * ⚠ 只认租户表里列出的子域，不放行整个 `*.jobs.feishu.cn`：后者等于申请一个
   *   能读该平台上所有公司招聘页的主机权限（理由见 feishu/tenants.ts）。
   */
  ...FEISHU_ATS_TENANTS
    .filter(tenant => tenant.id !== MEDIASTORM_SITE_ID)
    .map(createFeishuTenantDescriptor),
]

/** 租户 → 站点描述（主机权限、按钮配色、职位页都从租户表来） */
function createFeishuTenantDescriptor(tenant: FeishuAtsTenant): SiteDescriptor {
  return {
    id: tenant.id,
    label: tenant.label,
    jobsPageUrl: tenantJobsPageUrl(tenant),
    // 平台接口是公开的 JSON，取数方式与影视飓风完全相同
    source: 'api',
    color: tenant.color,
    textColor: tenant.textColor,
    matches: [`*://${tenantHostname(tenant)}/*`],
    hostnames: [tenantHostname(tenant)],
  }
}
