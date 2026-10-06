import type { SiteRef } from '~/logic/types'
import { sameApiView, sameJobFromUrl } from '../dom-fallback'
import { hostnameOf, isHostOf } from '../hostnames'
import { defineSite } from '../types'
import {
  buildDomFallbackJob,
  getPostBody,
  readJdFromDom,
  readJobOutlineFromDom,
} from './dom'
import meta from './meta'
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
 * （另一个是 meta.ts / selectors.ts / dom.ts）。
 */
export default defineSite({
  meta,

  /*
   * 没有要捕获的接口。`'dom'` 站点只能声明空数组 —— 给宿主页面白挂一层
   * fetch / XHR 包装是零收益的侵入（由 defineSite 的类型强制）。
   */
  watchedApiPaths: [],

  // 与路由层（routing.ts）共用同一套主机名判定，不另写一个正则
  matchUrl: url => isHostOf(hostnameOf(url), meta.hostnames),

  // /posts/z1fRK7 → z1fRK7
  naturalKeyFromUrl: postIdFromUrl,

  /*
   * 岗位页就是帖子页 `/posts/<slug>`（地址里带着帖子标识）。
   * 列表页 `/jobs-channel` 不算：那里不会展示某一个岗位的正文，用户点开帖子就换页了。
   *
   * ⚠ 与 DOM 层面的判据（selectors.ts 的 isJobPostPage：分类得是招聘类）分工不同：
   *   这里只回答「地址上有没有一个帖子」，那一页的帖子算不算招聘帖由 readJd 决定。
   */
  isJobPage: url => postIdFromUrl(url) !== '',

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
   * 这条判据与 V2EX 逐字相同，走共用骨架（sites/dom-fallback.ts 的 sameJobFromUrl）。
   */
  sameJob: (existing, jd) => sameJobFromUrl(postIdFromUrl, existing, jd),

  sameApiView,

  emptyRef: (naturalKey): SiteRef => ({ siteId: meta.id, naturalKey }),

  diagnose() {
    const selectors = [
      { key: 'title', label: '招聘帖标题行', selector: POST_TITLE },
      { key: 'categoryLink', label: '分类链接（招聘判据）', selector: POST_CATEGORY_LINK },
      { key: 'body', label: '帖子正文', selector: POST_BODY },
    ]

    return {
      selectors,
      domOutline: readJobOutlineFromDom(),
      jdLength: readJdFromDom()?.length ?? 0,
    }
  },
})
