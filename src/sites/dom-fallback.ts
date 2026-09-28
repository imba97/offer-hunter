import type { SiteDomOutline } from './types'
import type { JobCore, JobView, SiteId } from '~/logic/types'
import { createEmptyJobView, jobIdentity } from '~/logic/types'

/**
 * 「用页面 DOM 造一个岗位视图」的**站点无关骨架**。
 *
 * 两个站点此前各写一份（BOSS 是接口没捕获时的兜底、电鸭是唯一的取数路径），
 * 其中三条是**不变量** —— 各写一份就等于各给一次写歪的机会，而且两边的测试
 * 各测各的，改了一处不会有任何东西报警：
 *
 *  1. **标题兜底**：已有值（占位文案不算）→ DOM 新读到的 → 本站点的占位文案
 *  2. **站点身份**：保留 `base.site` 里的一切（含接口给的私有 id），并且保证
 *     `naturalKey` 非空 —— 站点给不出标识时按岗位内容定一个本地身份。
 *     没有身份就没有账本键：用户点完「匹配度分析」，分数只会出现在提示条里
 *     （真机故障）。
 *  3. **来源标记**：`source: 'dom'`，面板与诊断都读它
 *
 * 站点之间的差异（继承谁、清谁、名字怎么从页面捞）**全部留在站点侧**的 `job`
 * 回调与 `readJobOutlineFromDom` 里，这里不加任何开关 —— 为了把两个站点塞进一个
 * 函数而加 `inheritCompany` 之类的布尔参数，等于把「两份清晰的重复」换成
 * 「一份带分支的伪共用」，比重复更难读。
 */

export interface PreferTextInput {
  /** 已有的值（通常是上一份数据里的） */
  current?: string
  /** DOM 里新读到的值 */
  fromDom?: string
  /** 两边都没有时用的文案；不传即空串 */
  fallback?: string
  /**
   * 占位文案：`current` 等于它时不算「已有」。
   *
   * 只对标题有意义，但没有这条规则就会出事：一次兜底写下的占位标题，会在下一次
   * 兜底时被当成真实标题一直传下去（真机踩过）。
   */
  placeholder?: string
}

/** 已有值优先（占位文案不算「已有」），其次 DOM 新读到的，最后退回 fallback */
export function preferText(input: PreferTextInput): string {
  const { current, fromDom, fallback = '', placeholder } = input
  const existing = current && current !== placeholder ? current : ''
  return existing || fromDom || fallback
}

export interface DomFallbackInput {
  /** 本站点 id（写进 `JobView.site.siteId`） */
  siteId: SiteId
  /** 读不到标题时的占位文案（各站自己的说法） */
  emptyTitle: string
  jdText: string
  base?: Partial<JobView> | null
  outline?: SiteDomOutline | null
  /** 站点自己拼 JobCore：`title` 已经由上面的兜底规则算好 */
  job: (title: string, baseJob: JobCore | undefined) => JobCore
}

/** 用 DOM 读到的东西造一个岗位视图；三条不变量见文件头 */
export function buildDomFallbackView(input: DomFallbackInput): JobView {
  const base = input.base
  const baseJob = base?.job
  const title = preferText({
    current: baseJob?.title,
    fromDom: input.outline?.jobName,
    fallback: input.emptyTitle,
    placeholder: input.emptyTitle,
  })

  const view = createEmptyJobView({
    job: input.job(title, baseJob),
    // 站点身份沿用 base（含接口给的私有 id），只保证 naturalKey 非空
    site: {
      siteId: input.siteId,
      ...base?.site,
      naturalKey: base?.site?.naturalKey ?? '',
    },
    jdText: input.jdText,
    source: 'dom',
  })

  if (view.site.naturalKey)
    return view

  /*
   * 站点给不出标识（BOSS 新版职位页的地址里没有 securityId，而详情可能是服务端
   * 渲染、没有可捕获的接口响应）：按岗位内容定一个本地身份。
   *
   * 这一步刻意放在骨架里而不是调用方：让「DOM 兜底视图一定有身份」成为不变量 ——
   * 指望每个适配器都记得补一次，迟早会漏（漏了的症状是结果只进提示条）。
   */
  return { ...view, site: jobIdentity(view) }
}
