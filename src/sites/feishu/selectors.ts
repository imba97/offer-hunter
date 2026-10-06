import type { FeishuAtsTenant } from './tenants'

/**
 * 飞书招聘（飞书 ATS）页面相关的「脆弱点」集中管理：DOM 选择器与 URL 判断。
 *
 * 与 BOSS / 电鸭 / V2EX 那三份同构：平台改版时只需要改这一个文件，
 * 而不是全局搜索散落的 querySelector。差别在于这里的知识天然分两层：
 *
 *  - **全平台一致**：DOM 结构与路由（同一套前端，所有租户都一样）→ 本文件的常量与函数
 *  - **逐租户不同**：子域、官网路径、公司名、配色 → tenants.ts
 *
 * 注意：本扩展只**读取**页面，不做任何点击或代填。
 */

/*
 * ---------------------------------------------------------------------------
 * 关于类名里的 hash：本文件为什么长这样
 * ---------------------------------------------------------------------------
 * 飞书招聘的官网前端是 React + CSS Modules，类名形如
 *
 *   <div class="jobDetail__f7613e jobDetail">
 *
 * 也就是说每个类名后半段是一个构建期 hash（`__f7613e`）。它有两个性质：
 *
 *  - **不是随机的**：hash 由模块路径与内容算出，平台每次发版都会重新生成，
 *    因此在同一版本内是稳定的，跨版本就会变。
 *  - **但完整类名的前缀是稳定的**：`jobDetail` / `job-title` / `block-content`
 *    这些语义部分由源码里的写法决定，平台不会随手改。
 *
 * 于是本文件统一用 `[class*="xxx"]` 子串匹配，而不是写死带 hash 的完整类名：
 * 平台改版时命中的概率高得多。代价是「子串恰好出现在别的类名里」会误命中 ——
 * 这里选的几个词（`jobDetail` / `job-title` / `block-content`…）都足够独特，
 * 而且命中的元素本身还要通过结构（位置、父容器）校验，误命中不会带来错误数据。
 *
 * 真正稳定的锚点是 `data-test="jobTitle"`（平台自己给测试用的钩子），
 * 有它时优先用它，类名子串只是兜底。
 */

/**
 * 职位详情面板根节点。
 *
 * 真机结构（详情页）：
 *
 *   <div class="jobDetail__f7613e jobDetail">
 *     <div class="job-header sofiaBold"><span data-test="jobTitle" class="job-title">楼宇工程</span></div>
 *     <div class="job-money">10-15K<span class="job-money-unit">CNY/月</span></div>
 *     <div class="job-info">…城市 / 全职 / 职位类别…</div>
 *     <div class="block-title">职位描述</div>
 *     <div class="block-content">…</div>
 *     <div class="block-title">职位要求</div>
 *     <div class="block-content">…</div>
 *     <div class="apply-block"><button>投递</button></div>
 *   </div>
 *
 * 它是**整个面板**：MutationObserver 盯它（面板换掉 = 用户换了个岗位），
 * 标题 / 薪资 / 正文也都在它内部查。
 */
export const JOB_DETAIL_PANEL = '[class*="jobDetail"]'

/**
 * JD 正文所在的块级容器（`.job-content` 之类）。
 *
 * 观察器的廉价探针用它：只读它的 `textContent.length` 就能挡掉绝大多数突变。
 * 拿不到它时（面板还在加载）返回 null，内容脚本按 500ms 重试挂载。
 */
export const JOB_CONTENT = '[class*="job-content"], [class*="jobContent"]'

/** 正文段落块（「职位描述」「职位要求」各自一段） */
export const JOB_CONTENT_BLOCK = '[class*="block-content"]'

/** 岗位名 */
export const JOB_TITLE = '[data-test="jobTitle"]'

/** 薪资行（真机里是 `10-15K` + 一个 `.job-money-unit` 的 `CNY/月`） */
export const JOB_MONEY = '[class*="job-money"]'

/** 薪资行里的单位后缀节点（`CNY/月`），读薪资时要先摘掉它 */
export const JOB_MONEY_UNIT = '[class*="job-money-unit"]'

/**
 * 从 URL 里取岗位标识（详情地址上的那一串数字）。
 *
 * 真机上岗位地址有两种形态：
 *   /<官网路径>/position/7673106028406786331/detail   （用户直接打开 / 分享链接）
 *   /position/detail/7673106028406786331              （站内路由跳转）
 * 两者都要认，因此不锚定 `/position/` 之后紧跟的位置 —— 两种形态对**所有租户**
 * 都一样，所以它不需要租户配置。
 */
export function positionIdFromUrl(url: string): string {
  const match = /\/position\/(?:detail\/)?(\d+)/.exec(url)
  return match ? match[1] : ''
}

/**
 * 从详情接口地址里取岗位标识。
 *
 * 接口形如 `/api/v1/job/posts/7673106028406786331`，路径最后一段就是标识 ——
 * 与页面地址上的那串数字**是同一个值**（真机核对过），因此接口路径与页面地址
 * 两条路都能给出同一个 `naturalKey`。
 */
export function positionIdFromApiUrl(url: string): string {
  const match = /\/job\/posts\/(\d+)/.exec(url)
  return match ? match[1] : ''
}

/**
 * 当前页面地址对应的「官网路径」——接口 `website-path` 头的值。
 *
 * 页面自己是从内联的 `#js-websiteInfo` JSON 里读到它再带上请求的；我们只在
 * **主动补拉**（`fetchView` / `probeDetail`）时需要这个头，而它就在地址的第一段里
 * （`/<官网路径>/position/…`）。反推比读那段 JSON 稳：JSON 是页面内联的脚本内容，
 * 平台换渲染方式就可能没有；而 URL 第一段是路由的一部分，改了就等于全站链接失效。
 *
 * 站内路由形态（`/position/detail/<id>`）的第一段是 `position`，不是官网路径 ——
 * 那时退回该租户配置里的 `path`。这是唯一需要租户配置的地方，因此把配置作为参数
 * 显式传进来，而不是在模块里 import 某个具体租户（那会让平台层反过来依赖租户）。
 */
export function websitePathFromUrl(url: string, tenant: FeishuAtsTenant): string {
  try {
    const { pathname } = new URL(url, window.location.origin)
    const [first = ''] = pathname.split('/').filter(Boolean)
    return first && first !== 'position' ? first : tenant.path
  }
  catch {
    return tenant.path
  }
}
