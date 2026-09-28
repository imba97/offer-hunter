import type { DomJobSiteAdapter } from '../types'
import type { SiteRef } from '~/logic/types'
import { hostnameOf, isHostOf } from '../descriptors'
import { ELEDUCK_HOSTNAMES, ELEDUCK_JOBS_PAGE_URL, ELEDUCK_MATCHES, ELEDUCK_SITE_ID } from '../site-descriptors'
import {
  buildDomFallbackJob,
  getPostBody,
  readJdFromDom,
  readJobOutlineFromDom,
} from './dom'
import {
  POST_BODY,
  POST_CATEGORY_LINK,
  POST_TITLE,
  postIdFromUrl,
} from './selectors'

/**
 * 电鸭社区适配器。
 *
 * 与其他站点的关键差别是 `source: 'dom'`：电鸭没有可用的岗位接口（对非浏览器
 * 请求返回验证页），岗位完全从页面读 —— 所以这里不实现那四个接口方法，
 * manifest 也不会给这个站点注入 MAIN world 脚本。
 *
 * 本文件是**唯一**允许出现 `eleduck` / `page-title` 这类站点知识的边界之一
 * （另一个是 selectors.ts / dom.ts）。
 */
export const eleduckSite: DomJobSiteAdapter = {
  id: ELEDUCK_SITE_ID,
  label: '电鸭社区',
  jobsPageUrl: ELEDUCK_JOBS_PAGE_URL,

  source: 'dom',

  manifest: {
    matches: ELEDUCK_MATCHES,
    // 没有要捕获的接口（见文件头）
    watchedApiPaths: [],
  },

  // 与路由层（routing.ts）共用同一套主机名判定，不另写一个正则
  matchUrl: url => isHostOf(hostnameOf(url), ELEDUCK_HOSTNAMES),

  // /posts/z1fRK7 → z1fRK7
  naturalKeyFromUrl: postIdFromUrl,

  readJd: readJdFromDom,

  jdProbeElement: getPostBody,

  /*
   * ⚠ 这里刻意**不**做「是不是招聘帖」的判定：观察器需要一个稳定容器才挂得上，
   *   判定放进 readJd / readOutline（否则非招聘页会一直重试挂载）。
   */
  jdContainerElement: () => document.querySelector(POST_BODY),

  buildDomFallback: buildDomFallbackJob,

  readOutline: readJobOutlineFromDom,

  /**
   * 是否同一个岗位。
   *
   * 帖子地址里就带着 slug，因此优先比它；拿不到时退回文本比对 ——
   * DOM 读到的 JD 与已有 JD 在换行/分段上未必一致，用「互相包含」而不是相等。
   */
  sameJob(existing, jd) {
    const postId = postIdFromUrl(window.location.href)
    if (postId)
      return postId === existing.site.naturalKey
    if (!existing.jdText)
      return true
    return jd.includes(existing.jdText) || existing.jdText.includes(jd)
  },

  emptyRef: (naturalKey): SiteRef => ({ siteId: ELEDUCK_SITE_ID, naturalKey }),

  diagnose() {
    const selectors = [
      { key: '招聘帖标题行', selector: POST_TITLE },
      { key: '分类链接（招聘判据）', selector: POST_CATEGORY_LINK },
      { key: '帖子正文', selector: POST_BODY },
    ]

    return {
      selectors,
      domOutline: readJobOutlineFromDom(),
      jdLength: readJdFromDom()?.length ?? 0,
    }
  },
}
