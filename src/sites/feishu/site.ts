import type { ApiJobSiteAdapter, SiteDiagnostic } from '../types'
import type { FeishuAtsTenant } from './tenants'
import type { SiteRef } from '~/logic/types'
import { hostnameOf, isHostOf } from '../descriptors'
import { sameJobFromUrl } from '../dom-fallback'
import { fetchJobView, isDetailApiUrl, JOB_DETAIL_API, toJobView } from './api'
import { buildDomFallbackJob, getDetailPanel, getJdElement, readJdFromDom, readJobOutlineFromDom } from './dom'
import { JOB_CONTENT, JOB_CONTENT_BLOCK, JOB_DETAIL_PANEL, JOB_MONEY, JOB_TITLE, positionIdFromUrl } from './selectors'
import { tenantHostname, tenantJobsPageUrl } from './tenants'

/**
 * 飞书招聘的**租户特征层**：把平台层的能力与某一家公司的配置组合成一个站点适配器。
 *
 * 目录结构对应的就是这三层，未来的飞书招聘页面（别家公司）加在 `feishu/` 下面：
 *
 *   sites/feishu/              平台层：一套前端 + 一套接口的共用逻辑
 *     selectors.ts / api.ts / dom.ts   选择器、接口、翻译、DOM 兜底（纯平台知识）
 *     tenants.ts                       租户表（公司名、子域、官网路径、配色）
 *     site.ts（本文件）                 租户特征层：平台能力 + 租户配置 → 站点适配器
 *     mediastorm/                      某个租户的入口（content.ts / injected.ts）
 *   sites/boss/ eleduck/ v2ex/  其他平台各自一个目录
 *
 * 本文件与 `tenants.ts` 是唯一允许出现「主机名 = 租户子域」这类知识的地方。
 *
 * 为什么一家公司一个适配器（而不是一个「飞书招聘」适配器覆盖所有租户）：
 *  - 侧边栏「职位页」按钮上写的是**公司名**、用的是**公司主色**，跳转目标是
 *    该公司的职位列表 —— 这些逐租户不同，而按钮是按站点描述渲染的。
 *  - 账本键是 `<siteId>:<naturalKey>`：一家一个命名空间，两家公司的岗位标识
 *    即使撞车也不会互相覆盖。
 * 代价是每家公司要一份入口（两个文件），换来的是上面两条不用特判。
 */
export function createFeishuAtsSite(tenant: FeishuAtsTenant): ApiJobSiteAdapter {
  const hostname = tenantHostname(tenant)

  return {
    id: tenant.id,
    label: tenant.label,
    jobsPageUrl: tenantJobsPageUrl(tenant),

    /*
     * 取数方式是 'api'：岗位详情有一份公开的 JSON 接口（见 api.ts），
     * 比从页面上抠类名可靠得多 —— 那个平台的类名带构建期 hash
     * （见 selectors.ts 的 HASH 说明）。manifest 因此会给这个租户注入
     * MAIN world 脚本，用于被动捕获页面自己发出的详情请求。
     */
    source: 'api',

    manifest: {
      // 只认这一个租户子域，不放行整个 *.jobs.feishu.cn（见 tenants.ts）
      matches: [`*://${hostname}/*`],
      // 只监听详情接口：列表接口（/search/job/posts）不需要，界面只分析用户点开的那个岗位
      watchedApiPaths: [JOB_DETAIL_API],
    },

    // 与路由层（routing.ts）共用同一套主机名判定，不另写一个正则
    matchUrl: url => isHostOf(hostnameOf(url), [hostname]),

    // /index/position/7673106028406786331/detail → 7673106028406786331
    naturalKeyFromUrl: positionIdFromUrl,

    // 捕获到的是响应体原文，飞书招聘的信封是 { code, data }，解包在 toJobView 里做
    viewFromApiPayload: (payload, naturalKey) => toJobView(payload, naturalKey, tenant),

    isDetailApiUrl,

    fetchView: positionId => fetchJobView(positionId, tenant),

    async probeDetail(naturalKey) {
      const view = await fetchJobView(naturalKey, tenant)
      return {
        hasDescription: (view?.jdText.length ?? 0) > 0,
        preview: view?.jdText.slice(0, 120) ?? '',
      }
    },

    readJd: readJdFromDom,

    // 观察器的廉价探针：正文块容器（拿不到时内容脚本按 500ms 重试挂载）
    jdProbeElement: getJdElement,

    /*
     * MutationObserver 盯**整个详情面板**而不是正文块本身：
     * 面板是用户「换了一个岗位」的粒度，正文块则可能被整块替换（换岗位时先卸载
     * 再挂载），盯内层节点一被换掉观察器就失联；盯面板则「换掉」这个动作本身
     * 就是一次 childList 突变，正好被捕捉到。
     */
    jdContainerElement: getDetailPanel,

    buildDomFallback: (jdText, base, outline) => buildDomFallbackJob(jdText, tenant, base, outline),

    readOutline: () => readJobOutlineFromDom(tenant),

    /**
     * 是否同一个岗位。
     *
     * 与电鸭 / V2EX 逐字相同的判据走共用骨架（sites/dom-fallback.ts 的 sameJobFromUrl）：
     * 岗位地址里带着那串数字标识，优先比它；拿不到时退回文本比对。
     *
     * 这里比 BOSS 干净的地方在于：岗位标识是自然主键（不是每次访问新签的凭据），
     * 所以它**同时**是账本身份与判重依据，不需要像 BOSS 那样退回内容摘要。
     */
    sameJob: (existing, jd) => sameJobFromUrl(positionIdFromUrl, existing, jd),

    emptyRef: (naturalKey): SiteRef => ({ siteId: tenant.id, naturalKey }),

    diagnose(): SiteDiagnostic {
      const selectors = [
        { key: '详情面板', selector: JOB_DETAIL_PANEL },
        { key: '岗位名', selector: JOB_TITLE },
        { key: '薪资行', selector: JOB_MONEY },
        { key: 'JD 块容器', selector: JOB_CONTENT },
        { key: 'JD 段落', selector: JOB_CONTENT_BLOCK },
      ]

      return {
        selectors,
        domOutline: readJobOutlineFromDom(tenant),
        jdLength: readJdFromDom()?.length ?? 0,
      }
    },
  }
}
