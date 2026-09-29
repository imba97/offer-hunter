import type { ResumeSourceId } from './resume-sources/types'

/**
 * 全局领域模型。storage / content-script / background 三方共享，
 * 因此这里不引入任何运行时依赖，只放类型与默认值。
 */

// ---------------------------------------------------------------------------
// AI 平台配置
// ---------------------------------------------------------------------------

export type AiPlatformName = 'deepseek' | 'openai' | 'anthropic' | 'kimi' | 'custom'

export interface AiSettings {
  platform: AiPlatformName
  /** 留空时使用平台默认地址 */
  baseUrl: string
  apiKey: string
  /** 留空时使用平台默认模型 */
  model: string
  maxTokens: number
}

export function createDefaultAiSettings(): AiSettings {
  return {
    platform: 'deepseek',
    baseUrl: '',
    apiKey: '',
    model: '',
    maxTokens: 2048,
  }
}

// ---------------------------------------------------------------------------
// 简历
// ---------------------------------------------------------------------------

/**
 * 简历来源标识与适配器契约都在 logic/resume-sources 下（那套是可插拔的）。
 * 这里只做类型转出，让 storage / 内容脚本继续从「全局领域模型」这一个地方取类型。
 */
export type { ResumeSourceId } from './resume-sources/types'

/**
 * 简历。
 *
 * 刻意只有 Markdown 全文 —— 不再维护结构化的「求职偏好」（期望城市、薪资、
 * 学历、年限等）。那些字段原本只用于本地规则预筛，而预筛的判断质量明显不如
 * 直接让 AI 读完整简历 + JD，且需要用户额外填一堆表单。
 *
 * 匹配所需的信息全部由 AI 从 markdown 里理解。
 *
 * 无论简历来自手动输入还是 Gist，最终都以 `markdown` 为准喂给 AI：
 * 后台读简历时不需要知道它从哪来，也就不会出现「两种来源两套取数逻辑」。
 */
export interface Resume {
  /** Markdown 全文，喂给 AI 的主体 */
  markdown: string
  /** 当前生效的来源；null 是历史数据（当时还没有来源概念），按手动输入处理 */
  sourceId: ResumeSourceId | null
  /**
   * 各来源的配置，按来源 id 分组。
   *
   * 此前这里是 `gist: GistSource` 这样的**强类型兄弟字段**，加第二个来源就得往
   * Resume 上加一个字段、改 createEmptyResume、再改迁移逻辑。现在来源是可插拔的
   * （见 logic/resume-sources），域模型不能提前知道有哪些来源，只能给一张映射表。
   *
   * 用 `Partial` 是因为旧数据里未必每个来源都有配置；读取时由适配器的
   * createConfig() 补齐（见 storage.ts 的迁移）。
   */
  sources: Partial<Record<ResumeSourceId, Record<string, unknown>>>
  /** 最近一次成功同步的时间 */
  syncedAt: string | null
  /**
   * 最近一次同步的是哪一份内容（适配器给出的 contentKey），与 syncedAt 同时写入。
   *
   * 存在的意义：只有知道那个时间属于哪一份内容，才能判断「现在这份是不是刚取过」——
   * 否则换了来源内容之后，新的会被旧的同步时间挡住，看起来像坏掉了。
   *
   * 此前这个值由调用方手工拼成 `<gistId>|<fileName>`；现在由适配器自己算，
   * 上层只做字符串比较，不需要知道它由几个字段构成。
   */
  syncedKey: string | null
  updatedAt: string | null
}

export function createEmptyResume(): Resume {
  return {
    markdown: '',
    sourceId: null,
    sources: {},
    syncedAt: null,
    syncedKey: null,
    updatedAt: null,
  }
}

// ---------------------------------------------------------------------------
// 提示词（用户自己配，不设默认值）
// ---------------------------------------------------------------------------

/**
 * 用户自写的两段提示词，各自拼进对应那一轮的 system prompt。
 *
 * 分成两个字段而不是一段公用文本：打分与写作是两次独立的调用，想要的约束也
 * 完全不同（前者是评判口径，后者是文风与篇幅）。一段文本没法同时说清这两件事，
 * 硬塞进去只会让两边的提示词互相干扰。
 *
 * 原本这里还有个「匹配度阈值」，唯一作用是自动流程里判定「分数不够就跳过
 * 这个岗位」。自动化移除后它不参与任何逻辑（分数配色另有 85 / 75 / 60 的固定
 * 分档），留着只会让人以为它在管着什么，所以一并删掉。
 */
export interface PromptSettings {
  /**
   * 匹配度分析的额外评判口径，会拼进分析用的 system prompt。
   *
   * 例：「更看重高并发经验」「有开源贡献可以加分」「不看学历」。
   * 留空表示只按内置的评判原则打分。
   */
  matchPrompt: string
  /**
   * 生成招呼语的额外规则，会拼进生成用的 system prompt。
   *
   * 例：「开头使用「您好」」「不要提到薪资」「突出我的开源经历」。
   * 留空表示不加额外约束。
   */
  greetingPrompt: string
}

export function createDefaultPromptSettings(): PromptSettings {
  return {
    matchPrompt: '',
    greetingPrompt: '',
  }
}

// ---------------------------------------------------------------------------
// 账本保留策略
// ---------------------------------------------------------------------------

/**
 * 岗位账本保留多久。
 *
 * 默认 `0` = **永不按时间清理** —— 账本的用途就是「回头看同一个岗位不必重算」，
 * 而隔天回看恰恰是最常见的场景，默认短 TTL 会把最有用的一批记录清掉。
 * 想控制体积/留存的人可以自己选 30 / 90 / 365 天。
 *
 * ⚠ 判据是 **`firstSeen`（首次记录时间）**，不是「最后用过的时间」：
 *   那需要给记录加 `lastSeen` 字段并建索引（schema 升到 v2）。因此这个设置的含义
 *   要如实告诉用户 ——「按首次看到该岗位的时间清理」，而不是「按最近使用」。
 *
 * 无论这里选什么，账本都还有 **2000 条的条数上限**（超出丢最旧的，写时即执行），
 * 二者互相独立。
 */
export interface RetentionSettings {
  /** 保留天数；`0` 表示不按时间清理 */
  days: number
}

/** 可选天数（设置页的下拉项）；`0` 必须排在第一个，它是默认值 */
export const RETENTION_DAY_OPTIONS = [0, 30, 90, 365] as const

export function createDefaultRetentionSettings(): RetentionSettings {
  return { days: 0 }
}

// ---------------------------------------------------------------------------
// 岗位
// ---------------------------------------------------------------------------

/**
 * 招聘网站标识。
 *
 * 刻意是**开放字符串**而不是字面量联合：站点是可插拔的（见 src/sites/），
 * 而领域模型不该反过来知道有哪些站点 —— 闭合联合会逼着「加一个站点」还要改这里，
 * 那正是这次重构要消掉的那种耦合。
 *
 * 代价是拼错 id 不会被编译器拦住，改由 src/sites/__tests__ 的两条不变量兜底：
 * id 在注册表内唯一、且与 sites/<id>/ 目录名一致。
 */
export type SiteId = string

/**
 * 站点身份与站点私有数据。
 *
 * 存在的意义是把「站点的东西」从岗位本身里摘出去：这些字段的形状由各家的 wire
 * 格式决定（BOSS 叫 securityId / encryptBossId，别家叫别的），一旦混进
 * JobCore，加第二个站点时每个上层消费方都得改。
 *
 * `naturalKey` 是该站点内岗位的稳定标识。BOSS 用 URL 上的 securityId ——
 * 详情接口也只认它（encryptJobId 不行）。
 */
export interface SiteRef {
  /** 哪个站点；同时是账本主键的命名空间来源 */
  siteId: SiteId
  /**
   * 站点内唯一且稳定的岗位标识。
   *
   * 通常是站点自己给的（BOSS = URL 上的 securityId，电鸭 = /posts/<slug>）。
   * **站点给不出时这里是本地按岗位内容算出的摘要**（形如 `~1a2b3c4d`，见
   * jobIdentity）—— 那种岗位在平台上只存在于当前页面，没有可供深链的标识。
   */
  naturalKey: string
  /** 站点私有 id，原样保留供将来深链/刷新用，上层不读 */
  ids?: Record<string, string>
  /** 接口原始响应，仅供诊断；不上报、不参与匹配 */
  raw?: unknown
}

/** 办公地点。三个层级并非所有站点都给，缺失即省略。 */
export interface JobLocation {
  city?: string
  district?: string
  businessDistrict?: string
}

/** 招聘者（BOSS 叫「Boss」，别家叫 HR / 招聘负责人）。 */
export interface RecruiterCore {
  name: string
  title?: string
  online?: boolean
}

/**
 * 站点无关的岗位模型 —— **AI 匹配与侧边栏面板唯一依赖的形态**。
 *
 * 字段名刻意去掉站点色彩（jobName→title、brandName→company、bossName→recruiter）：
 * 这样加第二个招聘网站时，matching.ts / Sidepanel.vue / JobDetailCard.vue
 * 一行都不用改，只有站点适配器负责把自己的 wire 格式翻译成这个形状。
 *
 * ⚠ **除 `title` 外全部可选，且界面与提示词都必须容忍缺失。** 这些字段（薪资、
 *   学历、融资阶段、技能标签…）是 BOSS 那类结构化接口才有的东西；只读页面 DOM
 *   的来源（电鸭社区）天然只给得出「标题 + JD 正文」，硬凑只会凑出错误信息。
 *   因此适配器不实现它们不算缺陷，面板里对应的一行不渲染即可。
 *
 * 原先这里是 18 个必填字段且交织着 BOSS 私有字段（securityId / encryptJobId /
 * bossOnline），导致「领域模型」实际上就是 BOSS 的接口格式。
 */
export interface JobCore {
  title: string
  company?: string
  salary?: string
  experience?: string
  degree?: string
  location?: JobLocation
  /** 站点给出的技能标签 */
  skills?: string[]
  /** 公司信息（行业 / 规模 / 融资阶段），各家能给多少给多少 */
  companyIndustry?: string
  companyScale?: string
  companyStage?: string
  recruiter?: RecruiterCore
}

/**
 * 岗位 + JD 全文，即面板展示与 AI 分析的输入。
 *
 * 等于「通用岗位信息 + 站点身份 + 取数元数据」。三个分组各管一件事：
 * 适配器只负责填满它们，上层只读 `JobCore` 那部分。
 */
export interface JobView {
  job: JobCore
  site: SiteRef
  /** JD 全文 */
  jdText: string
  address?: string
  /** 来源：接口捕获 / DOM 回退 */
  source: 'api' | 'dom'
  capturedAt: string
}

/**
 * 造一个「只有 JD」的最小岗位视图。
 *
 * 存在的意义：字段一旦散落在多处各写一遍字面量，加字段就会漏改其中一两处，
 * 而漏改的表现是静默的 undefined（渲染期才炸）。统一从这里造。
 */
export function createEmptyJobView(patch: Partial<JobView> = {}): JobView {
  return {
    job: { title: '' },
    site: { siteId: 'boss', naturalKey: '' },
    jdText: '',
    source: 'dom',
    capturedAt: new Date().toISOString(),
    ...patch,
  }
}

/**
 * 岗位的本地记录（账本），键由 `recordKey()` 从 `siteId:naturalKey` 算出。
 *
 * 所有动作都由用户手动触发，所以这张表不是「待办队列」，而是**结果缓存**：
 * 在岗位之间来回切换时，之前算过的匹配结果与生成过的招呼语要能原样回来，
 * 不必每次重看都再烧一次 AI 配额。
 *
 * 刻意不记「状态」：那套状态机是为自动化流程（低于阈值自动跳过、自动推进到
 * 下一步）服务的，自动化移除后没有任何消费方，只会在界面上冒出「已跳过」
 * 这类用户既看不懂、也不需要关心的字样。
 *
 * ⚠ 显示字段是 JobCore 的**扁平快照**，不是嵌套的 `job: JobCore`。
 * 原因是 storage 的 mergeDefaults 只对 fallback 声明过的键做合并，
 * 存量记录里没有 `job` 这个键 → 会被填成 undefined → 面板读 `record.job.title`
 * 直接抛 TypeError。扁平字段名与旧记录一一对应，老数据天然读得出来。
 *
 * 键曾经只是 `securityId`（那个年代只有 BOSS）。加了第二个站点之后必须带站点
 * 命名空间，否则两家的标识撞车就会把 A 站的分析结果显示到 B 站的岗位上；
 * 迁移在 storage.ts 的 migrateRecordKeys 里做（旧数据一律属于 BOSS）。
 */
export interface JobRecord {
  /** 哪个站点（账本键的命名空间） */
  siteId: SiteId
  /** 站点内岗位标识：BOSS 是 URL 上的 securityId，电鸭是 /posts/<slug> 的 slug */
  naturalKey: string
  title: string
  company: string
  recruiterName: string
  salary: string
  match: MatchResult | null
  greeting: string | null
  /** 匹配或生成失败的原因 */
  error: string | null
  firstSeen: string
}

/**
 * 账本的键：`<siteId>:<naturalKey>`。
 *
 * 单独抽成函数而不是各处拼字符串：键的拼法一旦在两处不一致，症状是
 * 「分析成功了但切回来又要重算」——很难联想到是键写歪了。
 */
export function recordKey(ref: { siteId: SiteId, naturalKey: string }): string {
  return `${ref.siteId}:${ref.naturalKey}`
}

/**
 * `JobRecord` 的字段清单 —— 运行时版本的「模型白名单」。
 *
 * 存在的理由：存储里可能躺着**比今天的模型更多的字段**（存量数据来自旧版本，
 * 而 `mergeDefaults` 对账本这个动态键映射刻意不裁剪）。因此归一化必须按白名单
 * 重建记录，而不是逐个删除已知的旧字段 —— 后者永远追不上历史遗留。
 *
 * ⚠ 类型写成 `Record<keyof JobRecord, true>` 是**故意的**：给 `JobRecord` 增删字段
 *   而忘了改这里，编译就过不去。若写成 `string[]`，漏改的表现是「新加的字段
 *   在存量记录上被静默清掉」——那是最难查的一类 bug。
 */
export const JOB_RECORD_FIELDS: Record<keyof JobRecord, true> = {
  siteId: true,
  naturalKey: true,
  title: true,
  company: true,
  recruiterName: true,
  salary: true,
  match: true,
  greeting: true,
  error: true,
  firstSeen: true,
}

/**
 * 岗位的账本身份。
 *
 * 优先用站点给的天然标识（`site.naturalKey`）。**站点给不出时**退回一个按岗位
 * 内容算出的稳定摘要（前缀 `~`，与站点标识区分开）—— 这条退路是必须的：
 *
 * BOSS 新版职位页的地址里没有 securityId，而详情内容可能整块由服务端渲染
 * （页面上没有任何可捕获的详情接口响应），于是 DOM 兜底路径拿不到任何站点标识。
 * 若那时放弃记账，用户点「匹配度分析」后结果**只会出现在提示条里**，面板永远
 * 看不到分数与理由（真机故障）。有了摘要，这种岗位照样存得下、也查得回。
 *
 * ⚠ 摘要只取「标题 + JD 开头一段」而不是全文：页面上 JD 常常是**增量**渲染的
 *   （先出摘要、展开后出全文），用全文算，内容一变长就变成另一个身份，
 *   等于每次都要重新分析。
 */
export function jobIdentity(view: Pick<JobView, 'job' | 'site' | 'jdText'>): SiteRef {
  if (view.site.naturalKey)
    return view.site
  return { ...view.site, naturalKey: localJobKey(view) }
}

/**
 * 给「站点给不出标识」的岗位算一个本地身份（前缀 `~`）。
 *
 * 由 `jobIdentity` 使用，而 `jobIdentity` 又被 DOM 兜底骨架
 * （sites/dom-fallback.ts）用来在造视图时**定下**身份：之后只更新内容、不改身份，
 * 否则页面正文一增量渲染就换了个身份，用户刚分析过的结果会凭空消失。
 */
function localJobKey(view: Pick<JobView, 'job' | 'jdText'> | { title?: string, jdText: string }): string {
  return `~${contentDigest(view)}`
}

/** 摘要取样长度：够区分岗位，又不至于被「逐步加载的正文」影响 */
const IDENTITY_SAMPLE_CHARS = 200

/**
 * 岗位内容的短摘要（64 位十六进制）。
 *
 * 刻意用 FNV-1a 这种小实现而不是 crypto.subtle：后者是异步的，而身份要在
 * 同步路径上算出来（渲染、记账都等着它），且这里只需要「稳定 + 够短」。
 *
 * ⚠ 跑两遍、拼成 64 位而不是只用一个 32 位：账本上限 2000 条，单个 32 位
 *   在千条规模下已有约万分之一的撞车概率，而撞车的后果是**打开 A 岗位看到
 *   B 岗位的分析结果**这种静默错配。多跑一遍 ≤200 字符的循环可以忽略。
 */
function contentDigest(view: { job?: { title?: string }, title?: string, jdText: string }): string {
  const title = view.title ?? view.job?.title ?? ''
  const sample = `${title}\u0000${view.jdText}`
    .replace(/\s+/g, ' ')
    .slice(0, IDENTITY_SAMPLE_CHARS)

  // 两个不同的偏移基：同一个输入得到互不相关的两半
  return `${fnv1a(sample, 0x811C9DC5)}${fnv1a(sample, 0x01000193)}`
}

/** 32 位 FNV-1a，返回定长十六进制 */
function fnv1a(text: string, basis: number): string {
  let hash = basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// 匹配结果
// ---------------------------------------------------------------------------

/**
 * 匹配结果。
 *
 * 刻意没有 verdict（strong / ok / weak）这样的档位字段：它既不参与任何逻辑，
 * 界面上也从未展示过，等于每次分析都让模型多回一个没人看的字段。
 * 分数本身已经有 85 / 75 / 60 的颜色分档来承担这个表达。
 */
export interface MatchResult {
  score: number
  /** 命中的要点，给用户看 */
  reasons: string[]
  /** 简历里缺失、但 JD 要求的技能 */
  missingSkills: string[]
  /** 一句话结论 */
  summary: string
  /**
   * 输入（简历 / JD）超出平台上限被截断过。
   *
   * 面板会据此提示「评分可能受影响」—— 截断是静默的，不说出来用户会觉得
   * 模型判断得莫名其妙。
   */
  truncated?: boolean
}

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

export interface DiagnosticResult {
  url: string
  capturedApis: Array<{ url: string, ok: boolean, keys: string[], error?: string }>
  /** 是否已捕获到当前岗位 */
  hasCurrentJob: boolean
  currentJobName: string | null
  /** 岗位信息来源：接口捕获 / DOM 回退 */
  currentJobSource: 'api' | 'dom' | null
  /**
   * 当前岗位的账本键（`<siteId>:<naturalKey>`）。
   *
   * 摆在诊断里是为了让「面板为什么不显示分析结果」这类问题一眼可见：
   * 键是 `站点:~xxxx` 说明这个岗位没有站点标识、用的是本地内容摘要。
   */
  currentJobKey: string | null
  jdLength: number
  /** DOM 兜底读到的岗位标识（空串表示关键词选择器没命中，需要按真机调整） */
  domOutline?: { jobName: string, brandName: string }
  /**
   * 详情接口契约探针的结果。
   *
   * `null` 有两种含义，由「站点有没有接口」区分（面板据此换文案）：
   *  - `source: 'api'` 的站点：还没有拿到岗位标识，无从探测
   *  - `source: 'dom'` 的站点：本站点没有接口契约可验，这个探针永远不跑
   */
  detailProbe: {
    naturalKey: string
    ok: boolean
    hasPostDescription: boolean
    jdPreview: string
    error?: string
  } | null
  selectors: Array<{ key: string, selector: string, found: boolean, count: number }>
}
