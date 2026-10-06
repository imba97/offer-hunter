import type { ApiJobSiteAdapter, SiteMeta } from '../types'
import type { SiteRef } from '~/logic/types'
import { sameJobFromUrl } from '../dom-fallback'
import { hostnameOf, isHostOf } from '../hostnames'
import { defineSite } from '../types'
import { fetchJobView, isDetailApiUrl, JOB_DETAIL_API, toJobView } from './api'
import { buildDomFallbackJob, getDetailPanel, getJdElement, readJdFromDom, readJobOutlineFromDom } from './dom'
import { JOB_CONTENT, JOB_CONTENT_BLOCK, JOB_DETAIL_PANEL, JOB_MONEY, JOB_TITLE, positionIdFromUrl } from './selectors'

/**
 * 飞书招聘的**平台层**：一套前端 + 一套接口 + 多家公司子域。
 *
 * 目录分工（`sites/feishu/` 是平台，它下面的每个子目录是一个租户站点）：
 *   selectors.ts | api.ts | dom.ts   全平台一致的知识（选择器、接口、翻译、DOM 兜底）
 *   tenants.ts                       租户表：一个地方看全已支持的雇主（子域 + 官网路径）
 *   site.ts（本文件）                 平台能力 + 租户差异 → 站点适配器
 *   <公司>/meta.ts + index.ts        某个租户的站点定义（一行 defineSite）
 *
 * 将来加一家公司 = 新建 `sites/feishu/<公司>/`（meta.ts 写公司名与匹配地址，
 * index.ts 调本文件）+ 在 tenants.ts 的表里加一行。平台层一行都不用改。
 */

/**
 * 一个飞书招聘租户的**差异**：除站点描述（meta）之外，只有子域与官网路径。
 *
 * 它们同时是接口与地址的一部分（`<subdomain>.jobs.feishu.cn/<path>/…`），
 * 而公司名、配色、匹配地址这些展示与路由数据都在站点自己的 meta 里 ——
 * 一份数据只有一个出处。
 */
export interface FeishuAtsSiteInput {
  /** 该站点在飞书招聘上的子域，形如 `mediastorm`（不含 `.jobs.feishu.cn`） */
  subdomain: string
  /**
   * 官网路径，即接口 `website-path` 头的值（影视飓风是 `index`）。
   * 也是职位页地址的第一段：`/<path>/position`。
   */
  path: string
}

/** 站点描述 + 租户差异：接口与 DOM 层需要知道「这是哪一家」时的完整形态 */
export type FeishuAtsTenant = FeishuAtsSiteInput & { meta: SiteMeta }

/** 该租户的权威主机名（子域 + 平台域名） */
export function tenantHostname(subdomain: string): string {
  return `${subdomain}.jobs.feishu.cn`
}

/** 该租户的职位列表页地址（侧边栏按钮的目标） */
export function tenantJobsPageUrl(subdomain: string, path: string): string {
  return `https://${tenantHostname(subdomain)}/${path}/position`
}

/**
 * 由「站点描述 + 租户差异」造一个飞书招聘站点的适配器。
 *
 * 用法（`sites/feishu/<公司>/index.ts` 的全部内容）：
 *
 *   export default feishuAtsSite(meta, { subdomain: 'mediastorm', path: 'index' })
 *
 * 之所以能这么短：平台相关的部分（选择器、接口、翻译、DOM 兜底、判重）全在
 * 本目录里，租户之间只差子域、官网路径与 meta 里的几项展示数据。
 */
export function feishuAtsSite(
  meta: SiteMeta & { source: 'api' },
  tenant: FeishuAtsSiteInput,
): ApiJobSiteAdapter {
  const hostname = tenantHostname(tenant.subdomain)
  const full: FeishuAtsTenant = { ...tenant, meta }

  return defineSite({
    meta,

    // 只监听详情接口：列表接口（/search/job/posts）不需要，界面只分析用户点开的那个岗位
    watchedApiPaths: [JOB_DETAIL_API],

    // 与路由层（routing.ts）共用同一套主机名判定，不另写一个正则
    matchUrl: url => isHostOf(hostnameOf(url), [hostname]),

    // /index/position/7673106028406786331/detail → 7673106028406786331
    naturalKeyFromUrl: positionIdFromUrl,

    // 捕获到的是响应体原文，飞书招聘的信封是 { code, data }，解包在 toJobView 里做
    viewFromApiPayload: (payload, naturalKey) => toJobView(payload, naturalKey, full),

    isDetailApiUrl,

    fetchView: positionId => fetchJobView(positionId, full),

    async probeDetail(naturalKey) {
      const view = await fetchJobView(naturalKey, full)
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

    buildDomFallback: (jdText, base, outline) => buildDomFallbackJob(jdText, full, base, outline),

    readOutline: () => readJobOutlineFromDom(full),

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

    emptyRef: (naturalKey): SiteRef => ({ siteId: meta.id, naturalKey }),

    diagnose() {
      const selectors = [
        { key: '详情面板', selector: JOB_DETAIL_PANEL },
        { key: '岗位名', selector: JOB_TITLE },
        { key: '薪资行', selector: JOB_MONEY },
        { key: 'JD 块容器', selector: JOB_CONTENT },
        { key: 'JD 段落', selector: JOB_CONTENT_BLOCK },
      ]

      return {
        selectors,
        domOutline: readJobOutlineFromDom(full),
        jdLength: readJdFromDom()?.length ?? 0,
      }
    },
  })
}
