import type { SiteRef } from '~/logic/types'
import { hostnameOf, isHostOf } from '../hostnames'
import { defineSite } from '../types'
import { fetchJobDetail, fetchJobView, JOB_DETAIL_API, toJobView } from './api'
import { buildDomFallbackJob, getJdElement, readJdFromDom, readJobOutlineFromDom } from './dom'
import meta from './meta'
import {
  JOB_COMPANY_SELECTORS,
  JOB_DETAIL_BOX,
  JOB_DETAIL_DESC,
  JOB_TITLE_SELECTORS,
  securityIdFromUrl,
} from './selectors'

/**
 * BOSS 直聘适配器。
 *
 * 本文件是**唯一**允许出现 `zhipin` / `securityId` 这类站点知识的边界之一
 * （另一个是 meta.ts / api.ts / dom.ts / jd.ts / selectors.ts 这几个同目录文件）。
 * 加第二个招聘网站时，上层（内容脚本、后台、manifest、匹配分析、侧边栏）
 * 一行都不用改。
 *
 * ⚠ `id` / 名字 / 职位页 / 配色 / 匹配地址全在 meta.ts 里，这里只写「怎么做」：
 *   `defineSite` 会把 meta 原样带上，并从它派生 manifest.matches。
 */
export default defineSite({
  meta,

  /*
   * ⚠ 'api' 是 BOSS 的硬约束，不是保守选择：/wapi/ 只认浏览器会话 Cookie，
   * 而 MV3 的 service worker 发起的请求不带页面 Cookie —— 所以这些调用只能在
   * 页面上下文（内容脚本）里发起，侧边栏必须经后台转发给它。
   */
  // 只监听详情接口：岗位列表不需要（界面只分析用户点开的那个岗位）
  watchedApiPaths: [JOB_DETAIL_API],

  /*
   * 与路由层（routing.ts）用同一套主机名判定，不另写一个正则：
   * 两处各写一遍的话，改了一处就会出现「后台认为在 BOSS 页面、内容脚本不认」
   * 这种自相矛盾的状态。
   */
  matchUrl: url => isHostOf(hostnameOf(url), meta.hostnames),

  naturalKeyFromUrl: securityIdFromUrl,

  // 捕获到的是响应体原文，BOSS 的信封是 { code, zpData }，解包在这里做
  viewFromApiPayload: (payload, naturalKey) => toJobView((payload as any)?.zpData, naturalKey),

  isDetailApiUrl: url => url.includes(JOB_DETAIL_API),

  fetchView: naturalKey => fetchJobView(naturalKey),

  async probeDetail(naturalKey) {
    const detail = await fetchJobDetail(naturalKey)
    return {
      hasDescription: detail.jdText.length > 0,
      preview: detail.jdText.slice(0, 120),
    }
  },

  readJd: readJdFromDom,

  jdProbeElement: getJdElement,

  jdContainerElement: () => document.querySelector(JOB_DETAIL_BOX),

  buildDomFallback: buildDomFallbackJob,

  readOutline: readJobOutlineFromDom,

  /**
   * 是否同一个岗位。
   *
   * ⚠ securityId **不是**稳定标识（每次访问新签），所以这里不能拿它当判据：
   *   顶多「token 相同 → 一定是同一个岗位」这种单向推断。真正可靠的是正文比对 ——
   *   接口 JD 与 DOM 渲染出来的 JD 在换行/分段上未必一致，因此用「互相包含」
   *   而不是相等。
   */
  sameJob(existing, jd) {
    const securityId = securityIdFromUrl(window.location.href)
    if (securityId && existing.site.ids?.securityId === securityId)
      return true
    if (!existing.jdText)
      return true
    return jd.includes(existing.jdText) || existing.jdText.includes(jd)
  },

  /**
   * ⚠ 与接口路径同一个道理（见 api.ts 里 toJobView 的说明）：传进来的 key 是
   * **每次访问新签的 securityId**，不是稳定身份。所以身份留空、交给 `jobIdentity`
   * 按内容算摘要，token 存进 `ids` 供取数使用。
   *
   * eleduck 的同类实现把 key 当身份是对的 —— 那边是帖子 slug，本身稳定。
   */
  emptyRef: (fetchKey): SiteRef => ({
    siteId: meta.id,
    naturalKey: '',
    ids: { securityId: fetchKey },
  }),

  diagnose() {
    const selectorList: Array<[string, string]> = [
      ['详情 JD', JOB_DETAIL_DESC],
      ['详情容器', JOB_DETAIL_BOX],
      ...JOB_TITLE_SELECTORS.map((s, i): [string, string] => [`岗位名候选 ${i + 1}`, s]),
      ...JOB_COMPANY_SELECTORS.map((s, i): [string, string] => [`公司名候选 ${i + 1}`, s]),
    ]

    const selectors = selectorList.map(([key, selector]) => ({ key, selector }))
    const jd = readJdFromDom()

    return {
      selectors,
      domOutline: readJobOutlineFromDom(),
      jdLength: jd?.length ?? 0,
    }
  },
})
