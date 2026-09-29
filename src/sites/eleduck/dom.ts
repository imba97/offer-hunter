import type { SiteDomOutline } from '../types'
import type { JobView } from '~/logic/types'
import { buildDomFallbackView, titleOnlyJob } from '../dom-fallback'
import { ELEDUCK_SITE_ID } from '../site-descriptors'
import { readElementText } from '../text'
import { isJobPostPage, POST_BODY, readPostTitle } from './selectors'

/**
 * 电鸭社区页面上的 DOM 读取。
 *
 * 电鸭没有可用接口（对非浏览器请求会返回验证页），所以这个站点**只有**这一条取数路径：
 * 标题来自 `h1.page-title`、JD 来自 `.post-contents`。页面正常渲染时两者都在，
 * 未登录也不会被截断。
 *
 * 与 BOSS 那份的差别：BOSS 的 DOM 是「接口没捕获到时的兜底」，这里是主路径。
 * 读文本、`job` 回调、`sameJob` 都走共用实现（sites/text.ts、sites/dom-fallback.ts）。
 */

/**
 * DOM 兜底时拿不到标题，用这句占位，避免面板出现空白标题。
 *
 * 放在站点侧而不是通用模型里：这句文案描述的是「这个站点的标题没读到」，
 * 各家说法未必一样，不该由 JobCore 承担。
 */
const EMPTY_JOB_NAME = '（未能读到帖子标题）'

/** 正文容器本身（未渲染时返回 null） */
export function getPostBody(): HTMLElement | null {
  return document.querySelector<HTMLElement>(POST_BODY)
}

/**
 * 读取当前招聘帖的 JD 全文。
 *
 * ⚠ 「是不是招聘帖」的判定在这里，而不是在容器选择器里：观察器需要一个稳定的
 *   容器才挂得上（见 sites/types.ts 的说明）。非招聘帖（如「分享」类）返回 null，
 *   于是内容脚本不会产生任何岗位。
 */
export function readJdFromDom(): string | null {
  if (!isJobPostPage())
    return null
  const text = readElementText(getPostBody())
  return text.length > 0 ? text : null
}

/**
 * 从页面读岗位名。
 *
 * 电鸭的帖子标题就是岗位标题（前面的分类名由 readPostTitle 摘掉）。
 * 非招聘帖返回空串 —— 不给下游留下「这一页算不算岗位」的判断余地。
 */
export function readJobOutlineFromDom(): SiteDomOutline {
  if (!isJobPostPage())
    return { jobName: '', brandName: '' }
  return { jobName: readPostTitle(), brandName: '' }
}

/**
 * 用 DOM 里读到的 JD 造一个最小岗位视图。
 *
 * `base` 是「同一个岗位的已有数据」：能保留就保留，但**不能跨岗位复用** ——
 * 用户点开另一个帖子而这里没认出来时，沿用旧标题会把新 JD 记到旧岗位账上。
 *
 * 标题兜底、站点身份、来源标记这三条不变量在共用的骨架里（sites/dom-fallback.ts），
 * 这里只声明电鸭自己的差异：只带标题与公司（薪资/地点在帖子里是自由文本，不结构化提取）。
 */
export function buildDomFallbackJob(
  jdText: string,
  base?: Partial<JobView> | null,
  outline?: SiteDomOutline | null,
): JobView {
  return buildDomFallbackView({
    siteId: ELEDUCK_SITE_ID,
    emptyTitle: EMPTY_JOB_NAME,
    jdText,
    base,
    outline,
    // 只带标题：公司 / 薪资 / 地点在电鸭帖子里是自由文本，不做结构化提取
    // （「标题变了就不继承公司名」这条不变量在共用实现里）
    job: titleOnlyJob,
  })
}
