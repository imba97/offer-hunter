import type { SiteDomOutline } from '../types'
import type { JobView } from '~/logic/types'
import { buildDomFallbackView, titleOnlyJob } from '../dom-fallback'
import { readElementText } from '../text'
import { isJobPostPage, readTopicTitle, TOPIC_CONTENT } from './selectors'

/**
 * V2EX 页面上的 DOM 读取。
 *
 * V2EX 没有可供扩展使用的岗位接口（帖子内容是服务端渲染进 HTML 的，页面自己不
 * 调任何「帖子详情」接口），所以这个站点**只有**这一条取数路径：标题来自
 * `#Main .header h1`、JD 来自 `#Main .topic_content`。
 *
 * 与 BOSS 那份的差别：BOSS 的 DOM 是「接口没捕获到时的兜底」，这里是主路径
 * （与电鸭社区同构）。与电鸭的差别只有两处：节点判据（见 selectors.ts）与
 * 「整帖都算 JD」。读文本、`job` 回调、`sameJob` 都走共用实现
 * （sites/text.ts、sites/dom-fallback.ts）。
 */

/**
 * DOM 兜底时拿不到标题，用这句占位，避免面板出现空白标题。
 *
 * 放在站点侧而不是通用模型里：这句文案描述的是「这个站点的标题没读到」，
 * 各家说法未必一样，不该由 JobCore 承担。
 */
const EMPTY_JOB_NAME = '（未能读到帖子标题）'

/**
 * 正文容器本身（还没渲染出来时返回 null）。
 *
 * ⚠ 刻意**不**在这里判「是不是工作帖」，与适配器契约一致（见 sites/types.ts）：
 *   判据属于 readJd / readOutline。判别代价很低（一次 h1 查询），而契约上
 *   「观察器容器只回答容器在不在」这条边界一旦破掉，下一个人就会照抄到这里，
 *   于是非工作帖陷入 500ms 的挂载重试循环。
 */
export function getTopicBody(): HTMLElement | null {
  return document.querySelector<HTMLElement>(TOPIC_CONTENT)
}

/**
 * 读取当前工作帖的 JD 全文。
 *
 * 非工作帖（别的节点下的帖子、节点列表页、首页）返回 null，于是内容脚本不会
 * 产生任何岗位 —— 这是判断「这一页算不算岗位」的地方之一（另一处是
 * readJobOutlineFromDom）。
 *
 * ⚠ V2EX 上「帖子存在」不等于「帖子是岗位」，所以除了判据还要能读出非空正文：
 *   空帖子（只有标题、正文还没渲染）也返回 null，不然会造出一个空 JD 的岗位。
 */
export function readJdFromDom(): string | null {
  if (!isJobPostPage())
    return null
  const text = readElementText(getTopicBody())
  return text.length > 0 ? text : null
}

/**
 * 要观察 DOM 变化的容器。
 *
 * ⚠ 刻意返回 `.topic_content` 的**父元素**而不是它自己：V2EX 的正文可能整块被
 *   替换（编辑、以及某些渲染路径会换掉外层 cell），盯着内层的话节点一被换掉
 *   观察器就失联；盯外层则「换掉」这个动作本身就是一次 childList 突变，正好被
 *   捕捉到。父元素不存在时退回正文节点本身。
 *
 * 也刻意**不**盯 `#Main`：回复、广告位、分页都挂在 `#Main` 下的其它 cell 里，
 * 盯那么大等于「有人回帖」也触发一次正文读取。
 */
export function getTopicContainer(): Element | null {
  const body = getTopicBody()
  return body?.parentElement ?? body
}

/**
 * 从页面读岗位名。
 *
 * V2EX 的帖子标题就是岗位标题，没有分类名前缀要摘（节点信息在标题之外，
 * 正是 isJobPostPage 判据用的那条链接）。公司名留空 —— V2EX 的帖子里公司名是
 * 自由文本（往往只在正文里提一句），不做结构化提取。
 */
export function readJobOutlineFromDom(): SiteDomOutline {
  if (!isJobPostPage())
    return { jobName: '', brandName: '' }
  return { jobName: readTopicTitle(), brandName: '' }
}

/**
 * 用 DOM 里读到的 JD 造一个最小岗位视图。
 *
 * `base` 是「同一个岗位的已有数据」：能保留就保留，但**不能跨岗位复用** ——
 * 用户点开另一个帖子而这里没认出来时，沿用旧标题会把新 JD 记到旧岗位账上。
 *
 * 标题兜底、站点身份、来源标记这三条不变量在共用的骨架里（sites/dom-fallback.ts），
 * 这里只声明 V2EX 自己的差异：只带标题（薪资/地点在帖子里是自由文本）。
 */
export function buildDomFallbackJob(
  jdText: string,
  base?: Partial<JobView> | null,
  outline?: SiteDomOutline | null,
): JobView {
  return buildDomFallbackView({
    siteId: 'v2ex',
    emptyTitle: EMPTY_JOB_NAME,
    jdText,
    base,
    outline,
    // 只带标题：公司 / 薪资 / 地点在 V2EX 帖子里是自由文本，不做结构化提取
    // （「标题变了就不继承公司名」这条不变量在共用实现里）
    job: titleOnlyJob,
  })
}
