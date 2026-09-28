import type { JobView } from '~/logic/types'
import { createEmptyJobView } from '~/logic/types'
import { extractCleanText } from './jd'
import {
  JOB_COMPANY_SELECTORS,
  JOB_DETAIL_BOX,
  JOB_DETAIL_DESC,
  JOB_TITLE_SELECTORS,
} from './selectors'

/**
 * BOSS 直聘页面上的 DOM 读取。
 *
 * 本扩展**不再代填聊天输入框**：招呼语只生成到剪贴板，由用户自己粘贴发送。
 * 因此这里只剩「读页面」的能力，没有任何写入或点击操作 ——
 * 侵入性最低，也不会有误发消息的风险。
 */

/**
 * 详情面板节点本身（未渲染时返回 null）。
 *
 * 单独暴露出来是为了让轮询能先做一个**廉价**判断：读 `textContent.length`
 * 比 extractCleanText（克隆 + 逐元素取计算样式）便宜得多，绝大多数轮询都会
 * 在这里被挡掉。
 */
export function getJdElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(JOB_DETAIL_DESC)
}

/**
 * 读取当前详情面板里的 JD 全文。
 *
 * ⚠ 不能用 textContent 直接读：BOSS 会在 `.desc` 里注入反爬水印 ——
 * `<style>` 标签（内含 CSS 规则）和一批 `visibility:hidden` / `font-size:0`
 * 的隐藏元素。直接读会把 CSS 和隐藏文字当成 JD 正文显示出来。
 * extractCleanText 会克隆节点、剔除不可见元素后再取文本。
 */
export function readJdFromDom(): string | null {
  const el = getJdElement()
  if (!el)
    return null
  const text = extractCleanText(el)
  return text.length > 0 ? text : null
}

/** DOM 里能读到的岗位标识（薪资等字段 DOM 是加密乱码，读不到） */
export interface DomJobOutline {
  jobName: string
  brandName: string
}

/**
 * DOM 兜底时拿不到岗位名，用这句占位，避免面板出现空白标题。
 *
 * 放在站点侧而不是通用模型里：这句文案描述的是「BOSS 详情接口没读到」，
 * 别家站点兜底失败时的说法未必一样，不该由 JobCore 承担。
 */
export const EMPTY_JOB_NAME = '（未能从接口读取岗位信息）'

/** 标题/公司名的长度上限：超过这个长度基本是把整段描述当成了名字 */
const NAME_MAX_CHARS = 40

function firstShortText(scope: Element, selectors: string[]): string {
  for (const selector of selectors) {
    let matches: NodeListOf<Element>
    try {
      matches = scope.querySelectorAll(selector)
    }
    catch {
      continue
    }

    // 用下标遍历而不是 for...of：NodeList 的迭代器需要 DOM.Iterable，项目 lib 里没有
    for (let i = 0; i < matches.length; i++) {
      const text = (matches[i].textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text.length > 0 && text.length <= NAME_MAX_CHARS)
        return text
    }
  }
  return ''
}

/**
 * 从详情面板里读岗位名与公司名。
 *
 * 存在的意义：详情接口没捕获到时，兜底岗位此前只有一块 JD 正文，标题是占位符、
 * 公司为空 —— 面板看起来就像「还没加载出来」。这两个字段其实一直在 DOM 里。
 *
 * ⚠ 只读不猜：找不到就返回空串，交给调用方保留占位/接口数据。
 */
export function readJobOutlineFromDom(): DomJobOutline {
  const box = document.querySelector(JOB_DETAIL_BOX)
  if (!box)
    return { jobName: '', brandName: '' }

  return {
    jobName: firstShortText(box, JOB_TITLE_SELECTORS),
    brandName: firstShortText(box, JOB_COMPANY_SELECTORS),
  }
}

/** 已有值优先（占位标题不算「已有」），其次 DOM 读到的，最后退回 fallback */
function prefer(primary: string | undefined, secondary: string | undefined, fallback: string): string {
  const existing = primary && primary !== EMPTY_JOB_NAME ? primary : ''
  return existing || secondary || fallback
}

/**
 * 用 DOM 里读到的 JD 造一个最小岗位视图。
 *
 * `base` 是「同一个岗位的已有数据」：接口信息能保留就保留（薪资等字段 DOM 拿不到），
 * 但**不能跨岗位复用** —— 用户点了另一个岗位而详情接口没被捕获时，
 * 沿用旧岗位的公司名/薪资会张冠李戴，甚至把新 JD 记到旧岗位的账本上。
 *
 * `outline` 是刚从 DOM 读到的岗位名/公司名，只在 base 里没有可用值时生效。
 */
export function buildDomFallbackJob(
  jdText: string,
  base?: Partial<JobView> | null,
  outline?: DomJobOutline | null,
): JobView {
  const baseJob = base?.job

  return createEmptyJobView({
    job: {
      ...baseJob,
      title: prefer(baseJob?.title, outline?.jobName, EMPTY_JOB_NAME),
      // 占位/空公司名归一成 undefined，让「没有」只有一种表示
      company: prefer(baseJob?.company, outline?.brandName, '') || undefined,
      /*
       * 招聘者刻意**不**从 base 继承。
       *
       * 只有详情接口能给招聘者信息，DOM 读不到它；而这条路径的语义正是
       * 「接口数据没有或认不出是同一岗位」。此时保留 base 里的招聘者，
       * 就会把上一个岗位的 HR 挂到当前岗位上（同 base 里薪资/公司名不能跨岗位
       * 复用的是同一个坑，只是招聘者是从 job 对象里整个带过来的，更隐蔽）。
       */
      recruiter: undefined,
    },
    // 站点身份沿用 base（含接口给的私有 id），只补 naturalKey
    site: {
      siteId: 'boss',
      ...base?.site,
      naturalKey: base?.site?.naturalKey ?? '',
    },
    jdText,
    source: 'dom',
  })
}
