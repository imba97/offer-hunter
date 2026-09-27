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
// 招聘平台配置（阈值与限额，用户自己配，不设默认值）
// ---------------------------------------------------------------------------

export interface MatchingSettings {
  /** 匹配度阈值，达到才建议生成招呼语 */
  scoreThreshold: number
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
    scoreThreshold: 75,
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
 * 这张表是刚需而非优化：没有它，同一岗位会被重复分析、重复触达，
 * 既浪费配额，也是风控触发点。
 */
export interface JobRecord {
  securityId: string
  jobName: string
  brandName: string
  bossName: string
  salaryDesc: string
  status: OutreachStatus
  match: MatchResult | null
  greeting: string | null
  /** 匹配或触达失败的原因 */
  error: string | null
  firstSeen: string
}

export type OutreachStatus
  = | 'found' // 已捕获
    | 'scored' // 已评分
    | 'skipped' // 分数不足
    | 'drafted' // 已生成招呼语
    | 'failed'

// ---------------------------------------------------------------------------
// 匹配结果
// ---------------------------------------------------------------------------

export type MatchVerdict = 'strong' | 'ok' | 'weak'

export interface MatchResult {
  score: number
  verdict: MatchVerdict
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
