import type { SiteDomOutline } from '../types'
import type { FeishuAtsTenant } from './site'
import type { JobView } from '~/logic/types'
import { buildDomFallbackView, preferText } from '../dom-fallback'
import { readElementText } from '../text'
import {
  JOB_CONTENT,
  JOB_CONTENT_BLOCK,
  JOB_DETAIL_PANEL,
  JOB_MONEY,
  JOB_MONEY_UNIT,
  JOB_TITLE,
  positionIdFromUrl,
} from './selectors'

/**
 * 飞书招聘（飞书 ATS）页面上的 DOM 读取。
 *
 * 与 BOSS 那份同构：接口（api.ts）是主路径，这里是**接口没拿到时的兜底** ——
 * 直链打开却没有捕获到详情响应、或接口改版时，至少还能给出标题与正文。
 *
 * 真机结构见 selectors.ts 的文件头（面板 → 标题 / 薪资 / 一串 block-content）。
 *
 * 与 api.ts 一样，这里的函数都显式接收租户配置，不在模块里绑定任何具体租户。
 */

/**
 * DOM 兜底时拿不到标题，用这句占位，避免面板出现空白标题。
 *
 * 放在站点侧而不是通用模型里：这句文案描述的是「这个站点的标题没读到」，
 * 各家说法未必一样，不该由 JobCore 承担。
 */
export const EMPTY_JOB_NAME = '（未能从页面读取岗位信息）'

/** 岗位名 / 薪资这类短文本的长度上限：超过它基本是把整段描述当成了名字 */
const SHORT_TEXT_MAX_CHARS = 40

/** 详情面板根节点（未渲染时返回 null） */
export function getDetailPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(JOB_DETAIL_PANEL)
}

/**
 * JD 正文所在的块容器（未渲染时返回 null）。
 *
 * 观察器用它做**廉价探针**：先读 `textContent.length` 与首尾片段，
 * 比 `readElementText`（取 innerText、逐行归一化）便宜得多，绝大多数突变
 * 会在这里被挡掉。
 */
export function getJdElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(JOB_CONTENT)
}

/**
 * 读一个短文本节点（标题 / 薪资行）。
 *
 * 用 `textContent` 而不是 `readElementText`：这两个字段都是**单行短文本**，
 * 不需要按渲染结果分行，而 `innerText` 会触发一次样式计算 ——
 * 它在这个站点的轮询路径上（每 5 秒一次）不值得。
 */
function readShortText(selector: string): string {
  const el = document.querySelector(selector)
  if (!el)
    return ''
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 0 && text.length <= SHORT_TEXT_MAX_CHARS ? text : ''
}

/**
 * 薪资行去掉单位后缀。
 *
 * 真机 DOM：
 *   <div class="job-money">10-15K<span class="job-money-unit">CNY/月</span></div>
 *
 * 直接读 `textContent` 会得到 `10-15KCNY/月`。接口那条路给的是 `10-15K`，
 * 因此这里**摘掉单位节点再读**，两条路给出的文本一致 —— 用户刷新前后看到的
 * 薪资不会莫名其妙变个样子。
 */
export function readSalaryFromDom(): string {
  const el = document.querySelector(JOB_MONEY)
  if (!el)
    return ''

  const clone = el.cloneNode(true) as Element
  clone.querySelector(JOB_MONEY_UNIT)?.remove()
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 读取当前岗位的 JD 全文。
 *
 * 页面上「职位描述」与「职位要求」是并列的两段 `.block-content`，各自有
 * `.block-title` 小标题。这里按文档顺序把两段接起来，**不带小标题** ——
 * 与接口那条路给的正文形态一致（小标题由 composeJdText 按接口字段名补上，
 * 而 DOM 里的小标题是页面文案，不保证与接口字段对齐）。
 *
 * 兜底链，逐级放宽：
 *  1. `.job-content` 里的所有 `.block-content`
 *  2. 整个面板里的所有 `.block-content`（`.job-content` 改版或本就不存在时）
 *  3. 整个面板的正文（连块类名都改了：至少还能给出东西，而不是空手而归）
 *
 * 第 3 条是刻意的：这个平台的 DOM 全靠类名子串匹配（见 selectors.ts 的 HASH 说明），
 * 平台改版时最可能失守的就是类名；那时「退化成整段面板文本」比「什么都没有」好。
 * 面板里确实混着投递按钮（「投递」两个字），但代价只是 JD 末尾多两个字，
 * 而收益是正文没丢。
 */
export function readJdFromDom(): string | null {
  const panel = getDetailPanel()
  if (!panel)
    return null

  const scope = panel.querySelector(JOB_CONTENT) ?? panel
  let blocks = scope.querySelectorAll(JOB_CONTENT_BLOCK)

  // `.job-content` 改版或不存在时把范围放宽回整个面板
  if (blocks.length === 0 && scope !== panel)
    blocks = panel.querySelectorAll(JOB_CONTENT_BLOCK)

  const parts: string[] = []
  for (let i = 0; i < blocks.length; i++) {
    const text = readElementText(blocks[i])
    if (text)
      parts.push(text)
  }

  if (parts.length > 0)
    return parts.join('\n')

  const whole = readElementText(panel)
  return whole.length > 0 ? whole : null
}

/**
 * 从页面读岗位名与公司名。
 *
 * 公司名在页面上不出现，来自租户配置；但**只有真的在详情页上才给**：
 * 列表页 / 别的页面返回空串，不给下游留下「这一页算不算岗位」的判断余地
 * （与电鸭 / V2EX 的 readOutline 同一条规矩）。
 */
export function readJobOutlineFromDom(tenant: FeishuAtsTenant): SiteDomOutline {
  if (!getDetailPanel())
    return { jobName: '', brandName: '' }

  return {
    jobName: readShortText(JOB_TITLE),
    brandName: tenant.meta.label,
  }
}

/**
 * 「这份 base 数据属于当前页面上的这个岗位吗」。
 *
 * 判据是**地址上的岗位标识**，不是标题：标题在这条路径上优先取 base 里的值
 * （见共用骨架的兜底顺序），拿它做比较等于问 base 自己等不等于自己，永远为真。
 * 地址是页面提供的、与 base 无关的事实，用它才算真的比对。
 *
 * 拿不到任一标识时保守地认为「是同一个」（沿用 base 的信息）：这与共用骨架
 * 处理 `sameJob` 的取向一致 —— 宁可保留旧岗位的薪资，也不要把新岗位的数据记到
 * 旧账本上之后又抹掉用户已经看到的信息。
 */
function isSamePostingAsBase(base?: Partial<JobView> | null): boolean {
  const pagePositionId = positionIdFromUrl(window.location.href)
  const basePositionId = base?.site?.naturalKey ?? ''
  if (!pagePositionId || !basePositionId)
    return true
  return pagePositionId === basePositionId
}

/**
 * 用 DOM 里读到的 JD 造一个最小岗位视图。
 *
 * `base` 是「同一个岗位的已有数据」：接口信息能保留就保留（薪资、城市等 DOM
 * 给不全的字段），但**不能跨岗位复用** —— 用户点了另一个岗位而接口没被捕获时，
 * 沿用旧岗位的薪资会张冠李戴（与 BOSS 那份同一个坑）。
 *
 * 标题兜底、站点身份、来源标记这三条不变量在共用的骨架里（sites/dom-fallback.ts），
 * 这里只声明本平台自己的差异：公司名来自租户配置、薪资从 DOM 的薪资行读。
 */
export function buildDomFallbackJob(
  jdText: string,
  tenant: FeishuAtsTenant,
  base?: Partial<JobView> | null,
  outline?: SiteDomOutline | null,
): JobView {
  return buildDomFallbackView({
    siteId: tenant.meta.id,
    emptyTitle: EMPTY_JOB_NAME,
    jdText,
    base,
    outline,
    job: (title, baseJob) => {
      // 地址上的标识说了算：是另一个岗位就只认 DOM 刚读到的东西
      const sameAsBase = isSamePostingAsBase(base)
      const domSalary = readSalaryFromDom()

      return {
        title,
        company: preferText({ current: baseJob?.company, fromDom: outline?.brandName }) || undefined,
        salary: (sameAsBase ? baseJob?.salary : undefined) || domSalary || undefined,
        // 城市 / 招聘类型在 DOM 里是「杭州 · 全职 · 支持」这样挤在一行里的一串，
        // 不做结构化拆分（拆错了比不拆更糟）；接口那条路会给准确的字段。
        // 这条路径的语义是「数据来自 DOM」，所以只保证标题、公司名与薪资。
      }
    },
  })
}
