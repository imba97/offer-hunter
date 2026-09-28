import type { JobView, SiteId, SiteRef } from '~/logic/types'

/**
 * 招聘网站适配器契约。
 *
 * 一个站点要回答的全部问题都在这里：怎么认它的页面、怎么拿到岗位、怎么在页面上
 * 兜底读、页面改版时怎么诊断。**除了这个文件与各站点目录，别处不该出现平台名。**
 *
 * 分三层（与简历来源那套同构，但多一层「注入脚本契约」）：
 *   sites/<id>/     某个站点的全部站点私有逻辑（选择器、接口、清洗）
 *   sites/registry  注册表：新增站点在这里加一行
 *   manifest/后台   从注册表读取，因此都不需要改
 *
 * ⚠ 本文件与 registry.ts **不得引入任何运行时依赖**（尤其不能引 Vue 组件）：
 *   后台（service worker）要 import 注册表来做标签页路由，脚本（Node）要 import
 *   它来生成 manifest。组件一旦被拖进来，后台包会平白变大。
 */

/** 一个站点的 manifest 贡献：注入脚本读什么、匹配哪些地址 */
export interface SiteManifestSpec {
  /** 内容脚本要匹配的地址模式（写进 manifest 的 matches） */
  matches: string[]
  /**
   * 需要被动捕获的接口路径片段。MAIN world 的注入脚本据此过滤
   * 页面的 fetch / XHR —— 只捕获这些路径，别的响应连 clone 都不做。
   *
   * `source: 'dom'` 的站点这里必然是空数组（见下面的不变量）。
   */
  watchedApiPaths: string[]
}

/**
 * 站点的取数方式。**这是构建期与运行期共用的唯一判别**：
 *
 *  - `'api'`：岗位数据来自页面自己调用的接口，由 MAIN world 注入脚本被动捕获。
 *    有接口的站点必须实现 `viewFromApiPayload` / `isDetailApiUrl` / `fetchView`
 *    / `probeDetail` 四个方法（类型上由 ApiJobSiteAdapter 强制）。
 *    ⚠ 隐含一条架构硬约束：这类接口（如 BOSS 的 /wapi/）只认浏览器会话 Cookie，
 *      而 MV3 的 service worker 发起的请求**不带**页面 Cookie —— 因此这些调用只能
 *      在页面上下文（内容脚本）里发起，侧边栏必须经后台转发给它。
 *  - `'dom'`：站点没有可用的接口（或接口对非浏览器请求返回验证页，如电鸭社区），
 *    岗位数据只从页面 DOM 读。
 *
 * 为什么要有这个字段而不是「反正都给每个站点注入一份注入脚本」：给 DOM 站点挂
 * fetch / XHR 包装对宿主页面是**零收益的侵入**（manifest 也据此少一条 content_script）。
 */
export type JobSiteSource = 'api' | 'dom'

/** 诊断面板要复验的一项：选择器还命中吗 */
export interface SiteSelectorProbe {
  key: string
  selector: string
}

/** 诊断结果里站点自己贡献的那部分 */
export interface SiteDiagnostic {
  /** 逐个选择器的命中情况 */
  selectors: SiteSelectorProbe[]
  /** DOM 兜底读到的岗位标识（空串表示关键词选择器没命中，需要按真机调整） */
  domOutline?: { jobName: string, brandName: string }
  /** JD 长度 */
  jdLength: number
}

/**
 * 站点适配器的公共部分。
 *
 * 不在契约里的字段一律视为站点私有（如 BOSS 的 securityId / encryptJobId）：
 * 它们该留在 `JobView.site.ids` 里，而不是上升到通用模型。
 */
interface JobSiteAdapterBase {
  id: SiteId
  /** 展示用名字（诊断、提示文案里出现） */
  label: string
  /** 用户不在这个站点时，提示他去哪；也是点图标时的跳转目标 */
  jobsPageUrl: string
  source: JobSiteSource
  manifest: SiteManifestSpec

  /**
   * 这个 URL 是不是本站点。
   *
   * 是**标签页路由的唯一判据**：后台据此选目标标签页，侧边栏据此显示
   * 「当前标签页不是 X」的提示。因此它必须容许子域与 http/https。
   */
  matchUrl: (url: string | undefined) => boolean

  /** 页面地址 → 岗位标识（BOSS 用 URL 上的 securityId，电鸭用 /posts/<slug> 的 slug） */
  naturalKeyFromUrl: (url: string) => string

  /** 读当前详情面板里的 JD 全文（页面水印清洗在这里做） */
  readJd: () => string | null
  /**
   * 详情面板里的 JD 节点（未渲染时 null）。
   *
   * 单独暴露是为了让轮询能先做一个**廉价**判断：读 `textContent.length` 比
   * readJd（克隆 + 逐元素取计算样式）便宜得多，绝大多数轮询会在这里被挡掉。
   *
   * ⚠ 「这一页是不是招聘帖」的判定写在 readJd / readOutline 里，**不要**写在这里：
   *   观察器需要一个稳定的容器才能挂上，判定放进容器选择器会让非招聘页陷入
   *   500ms 的挂载重试循环。
   */
  jdProbeElement: () => HTMLElement | null
  /**
   * 要观察 DOM 变化的容器（未渲染时 null）。
   *
   * MutationObserver 挂在它上面而不是整个 document：范围小、且 SPA 换掉这一块
   * 时能通过 isConnected 立刻发现观察器已失联。
   */
  jdContainerElement: () => Element | null
  /** 用 DOM 读到的 JD 造一个最小岗位视图 */
  buildDomFallback: (
    jdText: string,
    base?: Partial<JobView> | null,
    outline?: { jobName: string, brandName: string } | null,
  ) => JobView
  /** DOM 兜底能读到的岗位名与公司名 */
  readOutline: () => { jobName: string, brandName: string }

  /**
   * 内容脚本用的共享状态辅助。
   *
   * 由站点提供而不是内容脚本自己写：这些判断依赖站点私有字段
   * （如 BOSS 的 securityId），放进通用代码就等于把站点细节泄漏上去。
   */
  sameJob: (existing: JobView, jd: string) => boolean
  /** 造一个只带站点身份的空视图，供 DOM 兜底用 */
  emptyRef: (naturalKey: string) => SiteRef

  /** 页面改版时复验用：选择器命中情况 + 兜底读取结果 */
  diagnose: () => SiteDiagnostic
}

/**
 * 有接口的站点。
 *
 * 四个接口方法在这里是**必填**（而不是可选后到处判空）：类型系统替运行期守住
 * 「声明了 source: 'api' 就必须真的会翻译接口响应」这条不变量。
 */
export interface ApiJobSiteAdapter extends JobSiteAdapterBase {
  source: 'api'

  /**
   * 从捕获到的**响应体原文**构造岗位视图；拿不到就返回 null（交给 DOM 兜底）。
   *
   * ⚠ 参数是响应体原文而不是「解包后的业务对象」：各家信封不同（BOSS 是
   *   `{ code, zpData }`，别家是 `{ data }` 或裸对象），解包是站点私有知识，
   *   不该由通用内容脚本代劳。这也正是这里把 `zpData` 改名为 `payload` 的原因。
   */
  viewFromApiPayload: (payload: unknown, naturalKey: string) => JobView | null
  /** 判断一个捕获到的响应体是不是「岗位详情」 */
  isDetailApiUrl: (url: string) => boolean
  /** 主动拉一个岗位的完整视图（内容脚本持有 Cookie，这条只能它来发） */
  fetchView: (naturalKey: string) => Promise<JobView | null>
  /** 详情接口探针：验证「标识 → JD」这条契约是否仍然成立 */
  probeDetail: (naturalKey: string) => Promise<{ hasDescription: boolean, preview: string }>
}

/** 只读 DOM 的站点：没有任何接口，因此也不需要上面那四个方法 */
export interface DomJobSiteAdapter extends JobSiteAdapterBase {
  source: 'dom'
}

export type JobSiteAdapter = ApiJobSiteAdapter | DomJobSiteAdapter

/** 便于各站点适配器标注自己的返回类型 */
export type { JobView, SiteId, SiteRef } from '~/logic/types'
