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

export type ResumeSourceId = 'paste' | 'pdf' | 'gist'

/**
 * 简历。
 *
 * 刻意只有 Markdown 全文 —— 不再维护结构化的「求职偏好」（期望城市、薪资、
 * 学历、年限等）。那些字段原本只用于本地规则预筛，而预筛的判断质量明显不如
 * 直接让 AI 读完整简历 + JD，且需要用户额外填一堆表单。
 *
 * 匹配所需的信息全部由 AI 从 markdown 里理解。
 */
export interface Resume {
  /** Markdown 全文，喂给 AI 的主体 */
  markdown: string
  sourceId: ResumeSourceId | null
  updatedAt: string | null
}

export function createEmptyResume(): Resume {
  return {
    markdown: '',
    sourceId: null,
    updatedAt: null,
  }
}

// ---------------------------------------------------------------------------
// 招呼语生成配置（用户自己配，不设默认值）
// ---------------------------------------------------------------------------

/**
 * 只剩「招呼语怎么写」这一件事。
 *
 * 原本这里还有个「匹配度阈值」，唯一作用是自动流程里判定「分数不够就跳过
 * 这个岗位」。自动化移除后它不参与任何逻辑（分数配色另有 85 / 75 / 60 的固定
 * 分档），留着只会让人以为它在管着什么，所以一并删掉。
 */
export interface MatchingSettings {
  /**
   * 生成招呼语时的自定义规则，会拼进生成用的 system prompt。
   *
   * 例：「开头使用「您好」」「不要提到薪资」「突出我的开源经历」。
   * 留空表示不加额外约束。
   */
  greetingPrompt: string
}

export function createDefaultMatchingSettings(): MatchingSettings {
  return {
    greetingPrompt: '',
  }
}

// ---------------------------------------------------------------------------
// 岗位
// ---------------------------------------------------------------------------

/**
 * 列表接口返回的岗位（接口字段的子集，只保留我们会用到的）。
 * 注意：薪资只有走接口才是明文，DOM 里是字体加密的乱码，不可用。
 */
export interface JobSummary {
  securityId: string
  encryptJobId: string
  encryptBossId: string
  jobName: string
  salaryDesc: string
  jobExperience: string
  jobDegree: string
  cityName: string
  areaDistrict: string
  businessDistrict: string
  brandName: string
  brandIndustry: string
  brandScaleName: string
  brandStageName: string
  bossName: string
  bossTitle: string
  bossOnline: boolean
  skills: string[]
}

/** 岗位 + JD 全文，即面板展示与 AI 分析的输入 */
export interface JobView extends JobSummary {
  jdText: string
  address: string
  /** 来源：接口捕获 / DOM 回退 */
  source: 'api' | 'dom'
  capturedAt: string
}

export interface JobDetail {
  jdText: string
  address: string
  skills: string[]
}

/** DOM 兜底时拿不到岗位名，用这句占位，避免面板出现空白标题 */
export const EMPTY_JOB_NAME = '（未能从接口读取岗位信息）'

/**
 * 造一个「只有 JD」的最小岗位视图。
 *
 * 存在的意义：这套字段有 22 个，三处各写一遍字面量时，任何一次加字段都会漏改其中
 * 一两处，而漏改的表现是静默的 undefined（渲染期才炸）。统一从这里造。
 */
export function createEmptyJobView(patch: Partial<JobView> = {}): JobView {
  return {
    securityId: '',
    encryptJobId: '',
    encryptBossId: '',
    jobName: EMPTY_JOB_NAME,
    salaryDesc: '',
    jobExperience: '',
    jobDegree: '',
    cityName: '',
    areaDistrict: '',
    businessDistrict: '',
    brandName: '',
    brandIndustry: '',
    brandScaleName: '',
    brandStageName: '',
    bossName: '',
    bossTitle: '',
    bossOnline: false,
    skills: [],
    jdText: '',
    address: '',
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
 */
export interface JobRecord {
  securityId: string
  jobName: string
  brandName: string
  bossName: string
  salaryDesc: string
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
