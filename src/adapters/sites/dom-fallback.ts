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

/**
 * 「站点只给得出标题」时 `job` 回调的共用实现（电鸭与 V2EX 同形）。
 *
 * 语义就是一条不变量：**标题变了就不继承公司名**。两个来源都给不出公司（帖子里的
 * 公司名是自由文本），所以能继承的只有 `base` 里那一份；而 `base` 属于上一次读到
 * 的那个帖子 —— 标题都变了还留着旧公司名，就是张冠李戴。
 *
 * ⚠ BOSS **不用**这个：它的 `job` 回调要另外显式清掉 recruiter（见 boss/dom.ts），
 *   形态不同。按本文件文件头的原则，那种差异留在站点侧，不做「带开关的伪共用」。
 */
export function titleOnlyJob(title: string, baseJob: JobCore | undefined): JobCore {
  return { title, company: title === baseJob?.title ? baseJob?.company : undefined }
}

/**
 * 「这两份**接口**数据说的是同一个岗位吗」，给「捕获到详情响应」那条路判重用。
 *
 * 与 `sameJobFromUrl` 的区别：那个比的是**页面地址**，这个比的是**两条接口数据**
 * （捕获到响应时未必拿得到地址）。而各站点的身份来源不一致：
 *
 *  - 多数站点（电鸭 / V2EX / 飞书各租户）的 `site.naturalKey` 是稳定主键 → 比它
 *  - BOSS 的 `naturalKey` **恒为空串**（securityId 每次访问都新签，当不了身份，
 *    见 boss/api.ts 的说明），但同一个岗位在同一页面先后两次响应里 `securityId`
 *    是一样的 → 那就比 `ids`
 *
 * ⚠ 比不出来时返回 **false**（宁可当成「可能是新岗位」去处理一次）。反方向错判成
 *   「同一个」会让面板停在旧数据上不再更新，代价更大。
 *   也正因为如此，这里**刻意不比 JD 文本**：增量渲染时同一岗位的文本本来就不同，
 *   拿文本当判据会把「真的换了岗位」误判成同一个。
 */
export function sameApiView(existing: JobView, incoming: JobView): boolean {
  if (existing.site.siteId !== incoming.site.siteId)
    return false

  const existingKey = existing.site.naturalKey
  const incomingKey = incoming.site.naturalKey
  if (existingKey && incomingKey)
    return existingKey === incomingKey

  /*
   * 两边都没有稳定主键时，退回站点私有 id 的交集比对：只要**有一个共同的 id 值相同**
   * 就认作同一个岗位。取交集而不是比整份对象，是因为各家塞进 `ids` 的字段不一样
   * （BOSS 有 securityId / encryptJobId / encryptBossId，其中 encryptJobId 可能缺）。
   */
  const existingIds = existing.site.ids
  const incomingIds = incoming.site.ids
  if (!existingIds || !incomingIds)
    return false

  return Object.keys(existingIds).some((key) => {
    const value = existingIds[key]
    return Boolean(value) && incomingIds[key] === value
  })
}

/**
 * 「是不是同一个岗位」的共用骨架，给**地址里带稳定标识**的 DOM 站点用。
 *
 * 电鸭（`/posts/<slug>`）与 V2EX（`/t/<id>`）的判据逐字相同，此前各写了一份 ——
 * 而它是写进适配器契约的行为（见 sites/types.ts 的 sameJob），不该有第三份实现。
 *
 * 两条规则，顺序有意义：
 *
 *  1. **地址上的标识说了算。** 它是站点给的稳定身份，比正文可靠：同一个帖子重渲染
 *     或被截断后文本会变，但标识不变。用文本判会让「每刷新一次就变成新岗位」，
 *     于是账本里同一岗位攒出多条记录、刚分析过的结果查不回来（真机故障）。
 *  2. **拿不到标识时才比文本，且用「互相包含」而不是相等。** JD 在接口与 DOM 两条
 *     路径上的换行/分段未必一致；严格相等会把同一岗位判成两个。
 *
 * `naturalKeyFromUrl` 由调用方注入（各站点从 URL 取标识的方式是站点私有知识），
 * 因此这里不引任何站点代码。
 */
export function sameJobFromUrl(
  naturalKeyFromUrl: (url: string) => string,
  existing: JobView,
  jd: string,
): boolean {
  const naturalKey = naturalKeyFromUrl(window.location.href)
  if (naturalKey)
    return naturalKey === existing.site.naturalKey
  if (!existing.jdText)
    return true
  return jd.includes(existing.jdText) || existing.jdText.includes(jd)
}
