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
 * 简历来源。
 *
 * 曾经还预留过 `'pdf'`，但 PDF 导入一直没做 —— 下拉框里摆一个点不动的选项，
 * 只会让人以为「选了 PDF 就会导入」。等导入器真做出来再加回去。
 */
export type ResumeSourceId = 'paste' | 'gist'

/**
 * Gist 同步配置。
 *
 * 没有 token 也能用：**读某一个 Gist 不需要任何凭据**（secret Gist 是「不被列出」
 * 而不是「要授权」，谁有链接谁能看）。token 是**可选**的，只为一件事 —— 把 GitHub
 * 接口的额度从匿名的每小时 60 次提升到每小时 5000 次。它不参与 AI 请求。
 */
export interface GistSource {
  /** 可选的 GitHub Personal access token，只为提额度；留空即匿名请求 */
  token: string
  /** Gist ID；粘贴 gist.github.com 链接时由 parseGistId 收敛成 ID */
  gistId: string
  /** 要同步的文件名；留空表示按文件名自动挑一个（见 pickResumeFile） */
  fileName: string
}

export function createEmptyGistSource(): GistSource {
  return {
    token: '',
    gistId: '',
    fileName: '',
  }
}

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
  /** Gist 同步配置（来源为手动输入时保留但不使用） */
  gist: GistSource
  /** 最近一次从 Gist 成功同步的时间 */
  syncedAt: string | null
  /**
   * 最近一次同步的是哪一份内容，形如 `<gistId>|<fileName>`，与 syncedAt 同时写入。
   *
   * 存在的意义：只有知道那个时间属于哪一份内容，才能判断「现在这份是不是刚取过」——
   * 否则换了 Gist 之后，新 Gist 会被旧 Gist 的同步时间挡住，看起来像坏掉了。
   */
  syncedFrom: string | null
  updatedAt: string | null
}

export function createEmptyResume(): Resume {
  return {
    markdown: '',
    sourceId: null,
    gist: createEmptyGistSource(),
    syncedAt: null,
    syncedFrom: null,
    updatedAt: null,
  }
}

/**
 * 把存储里的来源收敛成当前支持的两种之一。
 *
 * 存储里可能是 null（早于来源概念的旧数据）、也可能残留已废弃的值（如 `'pdf'`），
 * 这些一律按「手动输入」处理 —— 那正是它们原本的行为。
 */
export function normalizeResumeSource(value: unknown): ResumeSourceId {
  return value === 'gist' ? 'gist' : 'paste'
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
// 岗位
// ---------------------------------------------------------------------------

/**
 * 招聘网站标识。
 *
 * 目前只有 BOSS 一家。多站点接入后新增站点的适配器各自用自己的 id，
 * 上层（匹配分析、侧边栏）**不需要认识这些 id**，它们只读 JobCore。
 */
export type SiteId = 'boss'

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
  /** 站点内唯一且稳定的岗位标识（BOSS = securityId） */
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
 * 岗位的本地记录（账本），以 securityId 为键。
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
 * securityId 同理保留原名：它同时是这张表的键，改名会让存量账本的键失效。
 * 多站点接入时这里要换成 `siteId:naturalKey` 命名空间键（记忆：本步不动存储格式）。
 */
export interface JobRecord {
  securityId: string
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
  jdLength: number
  /** DOM 兜底读到的岗位标识（空串表示关键词选择器没命中，需要按真机调整） */
  domOutline?: { jobName: string, brandName: string }
  detailProbe: {
    securityId: string
    ok: boolean
    hasPostDescription: boolean
    jdPreview: string
    error?: string
  } | null
  selectors: Array<{ key: string, selector: string, found: boolean, count: number }>
}
