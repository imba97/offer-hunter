import type { JobView } from '~/logic/types'
import { createEmptyJobView } from '~/logic/types'
import { ELEDUCK_SITE_ID } from '../site-descriptors'
import { isJobPostPage, POST_BODY, readPostTitle } from './selectors'

/**
 * 电鸭社区页面上的 DOM 读取。
 *
 * 电鸭没有可用接口（对非浏览器请求会返回验证页），所以这个站点**只有**这一条取数路径：
 * 标题来自 `h1.page-title`、JD 来自 `.post-contents`。页面正常渲染时两者都在，
 * 未登录也不会被截断。
 *
 * 与 BOSS 那份的差别：BOSS 的 DOM 是「接口没捕获到时的兜底」，这里是主路径。
 */

/** DOM 里能读到的岗位信息（公司/薪资在电鸭帖子里是自由文本，不结构化提取） */
export interface DomJobOutline {
  jobName: string
  brandName: string
}

/**
 * DOM 兜底时拿不到标题，用这句占位，避免面板出现空白标题。
 *
 * 放在站点侧而不是通用模型里：这句文案描述的是「这个站点的标题没读到」，
 * 各家说法未必一样，不该由 JobCore 承担。
 */
export const EMPTY_JOB_NAME = '（未能读到帖子标题）'

/**
 * 文本归一化：按行 trim、丢掉空行、去掉零宽字符。
 *
 * ⚠ 保留换行而不是压成一行：JD 的段落结构是 AI 打分与阅读都要用的信息
 * （`innerText` 会按块级元素给出 `\n\n`）。
 */
function normalizePostText(text: string): string {
  return text
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n')
}

/**
 * 读元素文本。
 *
 * 优先 `innerText`：它按渲染结果给出换行（`textContent` 会把相邻块级元素的内容
 * 直接粘成一行）。**取不到时退回 `textContent`** —— jsdom 不实现 innerText，
 * 这条兜底让单测能覆盖真实逻辑；某些浏览器/未布局的后台标签页也会走到它。
 */
function textOf(el: Element | null): string {
  if (!el)
    return ''
  /*
   * 这里刻意用 innerText 而不是 textContent（eslint 的默认偏好正好相反）：
   * textContent 会把相邻块级元素的内容直接粘成一行，JD 的段落结构就丢了，
   * 而段落结构是 AI 打分与阅读都要用的信息。取不到时才退回 textContent。
   */
  // eslint-disable-next-line unicorn/prefer-dom-node-text-content
  const inner = (el as HTMLElement).innerText
  const raw = typeof inner === 'string' && inner.trim().length > 0
    ? inner
    : (el.textContent ?? '')
  return normalizePostText(raw)
}

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
  const text = textOf(getPostBody())
  return text.length > 0 ? text : null
}

/**
 * 从页面读岗位名。
 *
 * 电鸭的帖子标题就是岗位标题（前面的分类名由 readPostTitle 摘掉）。
 * 非招聘帖返回空串 —— 不给下游留下「这一页算不算岗位」的判断余地。
 */
export function readJobOutlineFromDom(): DomJobOutline {
  if (!isJobPostPage())
    return { jobName: '', brandName: '' }
  return { jobName: readPostTitle(), brandName: '' }
}

/** 已有值优先（占位标题不算「已有」），其次 DOM 读到的，最后退回 fallback */
function prefer(primary: string | undefined, secondary: string | undefined, fallback: string): string {
  const existing = primary && primary !== EMPTY_JOB_NAME ? primary : ''
  return existing || secondary || fallback
}

/**
 * 用 DOM 里读到的 JD 造一个最小岗位视图。
 *
 * `base` 是「同一个岗位的已有数据」：能保留就保留，但**不能跨岗位复用** ——
 * 用户点开另一个帖子而这里没认出来时，沿用旧标题会把新 JD 记到旧岗位账上。
 */
export function buildDomFallbackJob(
  jdText: string,
  base?: Partial<JobView> | null,
  outline?: DomJobOutline | null,
): JobView {
  const baseJob = base?.job
  const title = prefer(baseJob?.title, outline?.jobName, EMPTY_JOB_NAME)

  return createEmptyJobView({
    job: {
      // 只带标题：公司 / 薪资 / 地点在电鸭帖子里是自由文本，不做结构化提取
      title,
      // 标题变了说明已经是另一个帖子，不能把上一个帖子的字段带过来
      company: title === baseJob?.title ? baseJob?.company : undefined,
    },
    site: {
      siteId: ELEDUCK_SITE_ID,
      ...base?.site,
      naturalKey: base?.site?.naturalKey ?? '',
    },
    jdText,
    source: 'dom',
  })
}
