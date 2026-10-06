import type { JobView, SiteRef } from '~/logic/types'

/**
 * 招聘网站适配器契约。
 *
 * 一个站点要回答的全部问题都在这里：怎么认它的页面、怎么拿到岗位、怎么在页面上
 * 兜底读、页面改版时怎么诊断。**除了这个文件与各站点目录，别处不该出现平台名。**
 *
 * 两层，落在每个站点自己的目录里：
 *   sites/<id>/meta.ts   纯数据描述（defineSiteMeta），后台与 manifest 读它
 *   sites/<id>/index.ts  完整适配器（defineSite 声明，带 meta），注册表 glob 它
 * 因此「新增站点」= 加一个目录 + 两个文件，没有要改的集中表。
 *
 * ⚠ 本文件不得引入任何运行时依赖（尤其不能引 Vue 组件）：meta.ts 会被后台
 *   （service worker）glob 进来做标签页路由，也会被脚本（Node）读来生成 manifest。
 *   组件或 DOM 代码一旦被拖进来，后台包会平白变大。
 */

/**
 * 站点的取数方式。**这是构建期与运行期共用的唯一判别**：
 *
 *  - `'api'`：岗位数据来自页面自己调用的接口，由 MAIN world 注入脚本被动捕获。
 *    有接口的站点必须实现 `viewFromApiPayload` / `isDetailApiUrl` / `fetchView`
 *    / `probeDetail` 四个方法（类型上由 defineSite 的重载强制）。
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
 * 站点的**纯数据描述**（路由所需的最小信息）。
 *
 * 每个站点在自己的 `meta.ts` 里用 `defineSiteMeta()` 声明它，适配器（index.ts）
 * 把它原样带在 `meta` 字段上。分开两个文件是**为了后台包**：
 *
 *   meta.ts   纯数据：id / 名字 / 职位页 / 匹配哪些地址 / 是不是自家域名
 *   index.ts  完整适配器：选择器、DOM 读取、接口翻译、诊断
 *
 * 后台（service worker）只需要前者 —— 它要判断标签页属于哪个站点、跳去哪、
 * 怎么按地址查标签页。若它 import 适配器，就会把每个站点的 DOM 代码与选择器
 * 一起拖进后台包（实测确实会，`querySelector` 出现在后台产物里）。
 * 因此后台一律 glob `sites/**\/meta.ts`（见 routing.ts），
 * 只有内容脚本、侧边栏与测试才碰注册表（见 registry.ts）。
 */
export interface SiteMeta {
  /**
   * 站点标识。必须与 `src/sites/<id>/` 目录名一致 ——
   * 构建配置按目录约定生成产物路径，两者对不上就会出现「构建成功但注入不生效」。
   */
  id: string
  /** 展示用名字 */
  label: string
  /** 用户不在此站点时，点图标跳去的地址；也是侧边栏「打开职位页」按钮的目标 */
  jobsPageUrl: string
  /**
   * 取数方式（与适配器的 `source` 同源）。
   *
   * manifest 生成时读它：只有 `'api'` 的站点才注入 MAIN world 脚本 ——
   * DOM-only 的站点没有任何接口要被捕获，挂 hook 是纯侵入。
   */
  source: JobSiteSource
  /**
   * 平台主色（十六进制）。侧边栏「打开职位页」按钮用它做背景，
   * 让用户一眼分得清哪个按钮通向哪家。取自各平台自身的品牌色。
   */
  color: string
  /**
   * 主色上的文字颜色。
   *
   * 显式声明而不是按亮度算：品牌色有亮有暗（电鸭 #f9ba48 偏亮、BOSS #00bebd 偏深），
   * 算法给出的对比度未必是设计上最舒服的那个，配置永远可以覆盖它。
   */
  textColor: string
  /**
   * 该站点的匹配模式（写进 manifest 的 host_permissions 与 content_scripts）。
   * 适配器不再单独声明一份（见 defineSite）。
   */
  matches: string[]
  /**
   * 权威主机名，用于精确判断一个具体 URL 是否属于本站点。
   *
   * 与 `matches` 分开而不是从它反解：manifest 的模式串表达能力有限
   * （`*://*.zhipin.com/*`），而精确匹配要求「域名恰为 zhipin.com 或其子域」，
   * 不能用后缀 includes（`zhipin.com.evil.com` 会被误判为自家站点）。
   */
  hostnames: string[]
}

/**
 * 声明一个站点的纯数据描述。
 *
 * 存在的意义只有一条：**把描述写进站点自己的目录**（`sites/<id>/meta.ts`），
 * 而不是集中在一张表里。集中表的问题是「加一个站点要改两个地方」，
 * 而两者不同步时症状是「后台认这个域名、内容脚本没认」（或反过来），
 * 两侧各自看起来都对、很难查。
 *
 * 泛型参数把 `source` 的**字面量类型**保留下来：`feishuAtsSite()` 之类需要
 * `source: 'api'` 的工厂据此收窄（写成 `SiteMeta` 就会退化成联合类型而报错）。
 * 运行时它什么都不做 —— 返回什么就是什么，因为描述要能原样进 manifest。
 */
export function defineSiteMeta<const T extends SiteMeta>(meta: T): T {
  return meta
}

/** 诊断面板要复验的一项：选择器还命中吗 */
export interface SiteSelectorProbe {
  /**
   * 稳定标识（英文小驼峰）。
   *
   * ⚠ 这里**不要写给人看的文案**：它是测试与诊断结果里用来指认某一项的键，
   *   文案一变断言就碎（此前把中文标题填在这个字段里，正是那个毛病）。
   *   给人看的那份放 `label`。
   */
  key: string
  /** 展示用文案（中文）。界面读它；没有时退回 `key` */
  label?: string
  selector: string
}

/**
 * DOM 里能读到的那点岗位信息。
 *
 * 只有这两个字段：薪资、学历这类结构化字段 DOM 给不出来（BOSS 在页面上是字体
 * 加密的乱码、电鸭的帖子里是自由文本），所以它们不属于这个形状。
 *
 * 单独起个名字而不是到处写内联字面量：它同时出现在诊断结果、适配器的读函数
 * 与兜底构造的入参上，散着写就有五行各写一遍的机会。
 */
export interface SiteDomOutline {
  jobName: string
  brandName: string
}

/** 诊断结果里站点自己贡献的那部分 */
export interface SiteDiagnostic {
  /** 逐个选择器的命中情况 */
  selectors: SiteSelectorProbe[]
  /** DOM 兜底读到的岗位标识（空串表示关键词选择器没命中，需要按真机调整） */
  domOutline?: SiteDomOutline
  /** JD 长度 */
  jdLength: number
}

/**
 * 站点适配器的公共部分。
 *
 * 不在契约里的字段一律视为站点私有（如 BOSS 的 securityId / encryptJobId）：
 * 它们该留在 `JobView.site.ids` 里，而不是上升到通用模型。
 *
 * ⚠ `id` / `label` / `jobsPageUrl` / `source` 都不在这里，它们在 `meta` 上 ——
 *   后台与 manifest 只读得到 meta（纯数据），不能经由适配器去拿这些字段。
 */
interface JobSiteAdapterBase {
  /** 这个站点的纯数据描述（与 `meta.ts` 里那份是同一个对象） */
  meta: SiteMeta
  /** manifest 贡献；`matches` 由 meta 提供，因此这里只有「要捕获哪些接口」 */
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

  /**
   * 这个地址上会不会展示「某一个岗位」的内容 —— 一个**硬门槛**，不是提示。
   *
   * 内容脚本用它守住一条不变量：**当前岗位只属于产生它的那一页**。
   * 地址不再是岗位页时就把岗位清掉、也不再采集（DOM 与接口两条路都拦住），
   * 否则上一个岗位会跟着用户走到别的页面 —— 真机症状是「切到沟通页，面板还显示
   * 最后那个岗位」。各站点另有 DOM 层面的内容判据（`readJd` / `readOutline` 里的
   * `isJobPostPage` 之类），两者分工不同：这里回答「这一页算不算岗位页」，
   * 那里回答「这一页上的内容算不算一个岗位」。
   *
   * ⚠ 判据以**地址**为主：DOM 会被 SPA 保活、也会在换页的一瞬间空一帧，单看 DOM
   *   必然误判（隐藏着的旧详情面板看起来仍然「有岗位」）。**只有当同一个地址既可能是
   *   岗位页、也可能是别的页面时**，才进一步看页面现状来区分 —— BOSS 就是这种：
   *   `/job_detail/<id>.html` 既是独立职位详情页，也是列表页点开卡片后留在原页的
   *   右侧面板（DOM 完全不同）。哪种算岗位页由各站点自己定：
   *
   *   - BOSS 认列表 / 搜索页与「渲染出列表页面板」的详情地址；**独立职位详情页
   *     不认**（它的 DOM 结构与列表页不同，硬读出来的岗位名/公司名对不上真岗位，
   *     与其显示错的，不如让面板显示「还没有选中岗位」）
   *   - 电鸭 / V2EX / 飞书招聘只看地址里有没有岗位标识
   *
   * 取舍：把岗位页误判成非岗位页的代价是面板空着（不再读页面），把非岗位页误判成
   * 岗位页的代价是**显示一个用户已经不在看的岗位**。后者是用户看得见的错，因此
   * 判据要覆盖到「可能展示岗位」的全部地址形态。
   */
  isJobPage: (url: string) => boolean

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
  /**
   * 用 DOM 读到的 JD 造一个最小岗位视图。
   *
   * 实现请走 `sites/dom-fallback.ts` 的骨架（标题兜底、站点身份、来源标记三条
   * 不变量都在那里），站点只负责拼自己的 `job` 字段。
   */
  buildDomFallback: (
    jdText: string,
    base?: Partial<JobView> | null,
    outline?: SiteDomOutline | null,
  ) => JobView
  /** DOM 兜底能读到的岗位名与公司名 */
  readOutline: () => SiteDomOutline

  /**
   * 内容脚本用的共享状态辅助。
   *
   * 由站点提供而不是内容脚本自己写：这些判断依赖站点私有字段
   * （如 BOSS 的 securityId），放进通用代码就等于把站点细节泄漏上去。
   */
  sameJob: (existing: JobView, jd: string) => boolean
  /**
   * 「这两份接口数据说的是同一个岗位吗」—— 捕获到详情响应那条路的判重。
   *
   * 与 `sameJob` 分开而不是合并：那个比的是页面地址（用户在页面上的位置），
   * 这个比的是两条接口数据（可能拿不到地址）。
   *
   * ⚠ 必须**对本站点的真实身份来源**作答：BOSS 的 `naturalKey` 恒为空串，
   *   只比它就会恒为 false、每次都当新岗位重处理（真机症状：同一份 JD 反复翻译
   *   与广播）。共用实现见 `dom-fallback.ts` 的 `sameApiView`。
   */
  sameApiView: (existing: JobView, incoming: JobView) => boolean
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
 *
 * `kind` 是判别字段（其值是 `meta.source` 的类型）。冗余一个字段是为了让
 * **联合收窄可靠**：判别字段嵌在 `meta` 里时，`site.meta.source === 'api'`
 * 这类收窄在跨函数传递后会失效（真机症状：内容脚本里 `apiSite` 仍是联合类型，
 * `apiSite.fetchView` 报「不存在于 DomJobSiteAdapter 上」）。
 */
export interface ApiJobSiteAdapter extends JobSiteAdapterBase {
  kind: 'api'
  meta: SiteMeta & { source: 'api' }
  manifest: SiteManifestSpec & { watchedApiPaths: [string, ...string[]] }

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
  kind: 'dom'
  meta: SiteMeta & { source: 'dom' }
  manifest: SiteManifestSpec & { watchedApiPaths: [] }
}

export type JobSiteAdapter = ApiJobSiteAdapter | DomJobSiteAdapter

/** 联合收窄用的判别：内容脚本据此决定要不要跑接口那几条路 */
export function isApiSite(site: JobSiteAdapter): site is ApiJobSiteAdapter {
  return site.kind === 'api'
}

/**
 * 适配器里**不属于通用模型**的那部分：`defineSite()` 自己拼。
 *
 * 把这些字段从站点作者要写的东西里摘出去，是为了让「同一个事实只有一处」：
 *  - `id` / `label` / `jobsPageUrl` / `source` / `matches` 全在 `meta` 上
 *  - `kind` 就是 `meta.source`（判别字段，见 ApiJobSiteAdapter 的说明）
 *  - `watchedApiPaths` 由 `source` 决定（'api' 站点必须声明，'dom' 必须是空）
 *
 * 也正因为如此，`head` 里传了 `meta`，适配器就不可能在 `id`、`source` 或配色上与
 * meta 分叉 —— 那是「适配器与描述表各写一份」时代最容易踩的坑。
 */
type SiteAdapterHead = Omit<JobSiteAdapterBase, 'meta' | 'manifest'> & {
  meta: SiteMeta
}

/** `defineSite` 的入参：head + 有接口的站点那四个方法（`watchedApiPaths` 必需） */
type ApiSiteDefinition = SiteAdapterHead
  & { watchedApiPaths: [string, ...string[]] }
  & Omit<ApiJobSiteAdapter, keyof JobSiteAdapterBase | 'meta' | 'kind'>

/** `defineSite` 的入参：head + 不加任何接口方法（`watchedApiPaths` 只能是空） */
type DomSiteDefinition = SiteAdapterHead
  & { watchedApiPaths?: [] }
  & Omit<DomJobSiteAdapter, keyof JobSiteAdapterBase | 'meta' | 'kind'>

/**
 * 声明一个站点适配器。
 *
 * 三件事由它统一，站点作者不需要重复：
 *  1. **`meta` 就是描述**（`sites/<id>/meta.ts` 里那份），构造出的适配器把它原样带上；
 *     `manifest.matches` 也直接取 `meta.matches` —— 此前适配器与描述表各写一份
 *     「匹配哪些地址」，改漏一处就是「后台认这个域名、内容脚本不认」。
 *  2. **`kind` 就是 `meta.source`**：支持联合收窄的判别字段（见 ApiJobSiteAdapter）。
 *  3. **`source` 与 `watchedApiPaths` 的一致性**（两条重载强制）：`'api'` 站点
 *     必须声明至少一条要捕获的接口路径，`'dom'` 站点不许声明 —— 后者挂了
 *     fetch / XHR 包装对宿主页面是零收益的侵入。
 *
 * 注册表按目录约定 glob 各站点的 `index.ts`，所以每个站点目录
 * **必须默认导出** `defineSite(...)` 的结果（见 registry.ts）。
 */
export function defineSite(definition: ApiSiteDefinition): ApiJobSiteAdapter
export function defineSite(definition: DomSiteDefinition): DomJobSiteAdapter
export function defineSite(
  definition: ApiSiteDefinition | DomSiteDefinition,
): JobSiteAdapter {
  const { meta, watchedApiPaths, ...rest } = definition

  return {
    ...rest,
    kind: meta.source,
    meta,
    manifest: {
      matches: [...meta.matches],
      watchedApiPaths: watchedApiPaths ? [...watchedApiPaths] : [],
    },
  } as JobSiteAdapter
}
