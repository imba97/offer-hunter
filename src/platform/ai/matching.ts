import type { AiSettings, JobCore, MatchResult, Resume } from '~/logic/types'
import type { AiProvider } from '~/platform/ai/platforms'
import type { PingResult } from '~/platform/ai/types'
import { createAiProvider } from '~/platform/ai/platforms'
import { requestJson } from '~/platform/ai/structured'

/**
 * 匹配与招呼语生成。
 *
 * 判断全部交给 AI：完整简历 + JD 一起给它读。
 * 这里刻意**没有本地规则预筛** —— 预筛依赖结构化的求职偏好字段
 * （期望城市/薪资/学历/年限），而那些字段既要求用户额外填表，判断质量也明显
 * 不如让模型直接读全文。代价是每个岗位都会调用一次 AI。
 */

function makeProvider(settings: AiSettings): AiProvider {
  const apiKey = settings.apiKey?.trim()
  if (!apiKey)
    throw new Error('尚未配置 AI API Key，请先到设置页填写')

  const isCustom = settings.platform === 'custom'
  if (isCustom && !settings.baseUrl?.trim())
    throw new Error('自定义端点需要填写接口地址')
  if (isCustom && !settings.model?.trim())
    throw new Error('自定义端点需要填写模型名')

  return createAiProvider(settings.platform, {
    baseUrl: settings.baseUrl?.trim() || undefined,
    apiKey,
    model: settings.model?.trim() || undefined,
    maxTokens: settings.maxTokens,
  })
}

/**
 * 连通性测试：验证接口地址、API Key、模型名三者是否都可用。
 *
 * 与匹配分析分开，是因为这三项任一配错都会让匹配失败，
 * 而混在一起时无法判断到底是哪一项的问题。
 */
export async function testAiConnection(settings: AiSettings): Promise<PingResult & { provider: string, model: string, baseUrl: string }> {
  const provider = makeProvider(settings)
  const result = await provider.protocol.ping(provider.config)
  return {
    ...result,
    provider: provider.name,
    model: provider.config.model,
    baseUrl: provider.config.baseUrl,
  }
}

// ---------------------------------------------------------------------------
// 输入裁剪
// ---------------------------------------------------------------------------

/** 留给 system prompt 与输出要求的字符余量 */
const PROMPT_RESERVE = 2_000
/** JD 最多占可用预算的比例 —— 简历才是判断主体，JD 通常也只有一两千字 */
const JD_BUDGET_RATIO = 0.4

function clip(text: string, limit: number, label: string): string {
  if (limit <= 0)
    return ''
  if (text.length <= limit)
    return text
  const note = `\n…（${label}过长，此处已截断）`
  return text.slice(0, Math.max(0, limit - note.length)) + note
}

/**
 * 按平台声明的输入上限裁剪简历与 JD。
 *
 * 此前 `maxInputChars` 只是声明，没人读 —— 简历与 JD 原样拼接，长简历
 * （将来支持 PDF 导入后更容易出现）会直接撞上下文上限或报 400。
 */
export function fitInputs(
  provider: AiProvider,
  resumeMarkdown: string,
  jdText: string,
): { resume: string, jd: string, truncated: boolean } {
  const budget = Math.max(4_000, provider.capabilities.maxInputChars - PROMPT_RESERVE)
  const jdLimit = Math.min(jdText.length, Math.floor(budget * JD_BUDGET_RATIO))
  const resume = clip(resumeMarkdown, budget - jdLimit, '简历')
  const jd = clip(jdText, budget - resume.length, 'JD')

  return {
    resume,
    jd,
    truncated: resume.length < resumeMarkdown.length || jd.length < jdText.length,
  }
}

// ---------------------------------------------------------------------------
// 模型返回值的归一化
// ---------------------------------------------------------------------------

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value))
    return []
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map(v => v.trim())
    .slice(0, max)
}

/**
 * 把模型给的分数收敛成 0-100 的整数。
 *
 * 兼容两种常见偏差：字符串数字（"85"）、0-1 的比例（0.85）。
 * 注意只在**小数且小于 1** 时才按比例还原 —— 整数 1 分不该被当成 100。
 */
export function normalizeScore(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(num))
    return null

  const scaled = num > 0 && num < 1 ? num * 100 : num
  return Math.round(Math.min(100, Math.max(0, scaled)))
}

/**
 * 校验并归一化模型返回的匹配结果。
 *
 * 之前是直接把 JSON 断言成 MatchResult：模型漏一个字段，上层
 * `match.reasons.join('；')` 就抛「Cannot read properties of undefined」，
 * 用户看到的是 TypeError 而不是「模型这次没按格式回」。缺失分数则明确报错，
 * 不静默当成 0 分。
 */
export function normalizeMatchResult(raw: unknown): MatchResult {
  const data = (raw ?? {}) as Record<string, unknown>

  const score = normalizeScore(data.score)
  if (score === null)
    throw new Error('模型返回的数据里没有可用的匹配度分数（score），请重试或更换模型')

  return {
    score,
    summary: typeof data.summary === 'string' ? data.summary.trim() : '',
    reasons: stringList(data.reasons, 8),
    missingSkills: stringList(data.missingSkills, 8),
  }
}

// ---------------------------------------------------------------------------
// AI 精判
// ---------------------------------------------------------------------------

/**
 * 把用户自定义提示词接到内置提示词后面。
 *
 * 单独成段并声明优先级，避免与上面的通用要求混在一起时被模型当成「建议」而忽略。
 * 冲突时以用户规则为准 —— 那是他明确的意图。两段提示词（打分口径、招呼语规则）
 * 走同一条拼装路径，免得只有一边享受「优先级最高」这个待遇。
 */
export function withUserPrompt(base: string, userPrompt: string): string {
  const custom = userPrompt.trim()
  if (!custom)
    return base

  return `${base}

## 用户的额外要求（优先级最高）
以下要求由用户指定，请严格遵循。若与上面的通用要求冲突，以本节为准：
${custom}`
}

const MATCH_SYSTEM = `你是一位资深的技术招聘顾问，擅长判断候选人与岗位的真实匹配程度。

评判原则：
- 基于简历中**实际写出**的经历与技能判断，不要脑补候选人可能具备的能力
- 区分「硬性要求」（技术栈、年限、学历）与「加分项」，硬性要求缺失要显著扣分
- 警惕表面关键词匹配：用过某技术一次 ≠ 精通，要结合项目描述的深度判断
- 分数分布要有区分度：真正高度吻合才给 85 以上，明显不足给 40 以下`

const MATCH_SCHEMA_HINT = `json 结构：
{
  "score": 0-100 的整数,
  "summary": "一句话结论，30 字以内",
  "reasons": ["命中要点，每条一句话，2-5 条"],
  "missingSkills": ["简历中缺失但岗位要求的技能，0-5 条"]
}`

/**
 * 匹配度分析用的 system prompt（含用户自定义的评判口径）。
 *
 * 用户写的是「怎么打分」，不是「怎么回 JSON」：输出结构由 requestJson 追加在
 * 最后，仍然生效。
 */
export function buildMatchSystem(userPrompt: string): string {
  return withUserPrompt(MATCH_SYSTEM, userPrompt)
}

/**
 * 把岗位信息拼成一段给模型看的文字。
 *
 * 只读 JobCore 的通用字段 —— 站点私有字段（BOSS 的 securityId / encryptJobId /
 * bossOnline）刻意不进来：它们对判断匹配度毫无帮助，反而会把站点细节泄漏进提示词。
 * 这也是「加第二个招聘网站时本文件不用改」的原因。
 */
function describeJob(job: JobCore, opts: { withRecruiter: boolean }): string {
  return [
    `职位：${job.title}`,
    `公司：${job.company ?? ''}${formatCompanySuffix(job)}`,
    `薪资：${job.salary ?? ''}`,
    `经验要求：${job.experience ?? ''}`,
    `学历要求：${job.degree ?? ''}`,
    `地点：${formatLocation(job)}`,
    job.skills?.length ? `技能标签：${job.skills.join('、')}` : '',
    opts.withRecruiter && job.recruiter
      ? `招聘者：${job.recruiter.name}${job.recruiter.title ? `（${job.recruiter.title}）` : ''}`
      : '',
  ].filter(Boolean).join('\n')
}

/**
 * 供提示词使用的岗位描述文本。
 *
 * 导出仅为单测：它是「通用模型 → 提示词」的唯一出口，站点私有字段一旦从这里
 * 漏进提示词（例如又把 securityId 拼进去），加第二个站点时就会暴露不一致。
 */
export function buildPromptJobText(job: JobCore, opts: { withRecruiter?: boolean } = {}): string {
  return describeJob(job, { withRecruiter: Boolean(opts.withRecruiter) })
}

/** 公司后缀（行业 / 规模 / 融资阶段），有才拼 */
function formatCompanySuffix(job: JobCore): string {
  const parts = [job.companyIndustry, job.companyScale].filter(Boolean)
  return parts.length > 0 ? `（${parts.join(' / ')}）` : ''
}

/** 地点：城市 · 区 · 商圈，逐级拼 */
function formatLocation(job: JobCore): string {
  const loc = job.location
  if (!loc)
    return ''
  return [loc.city, loc.district].filter(Boolean).join('')
    + (loc.businessDistrict ? ` · ${loc.businessDistrict}` : '')
}

export interface PromptOptions {
  /** 用户自定义提示词；留空（或只有空白）表示只按内置要求 */
  userPrompt?: string
}

export async function matchJob(
  settings: AiSettings,
  resume: Resume,
  job: JobCore,
  jdText: string,
  opts: PromptOptions = {},
): Promise<MatchResult> {
  const provider = makeProvider(settings)

  if (resume.markdown.trim().length === 0)
    throw new Error('简历为空，请先到设置页填写简历')

  const input = fitInputs(provider, resume.markdown, jdText)

  const user = [
    '## 我的简历',
    input.resume,
    '',
    '## 目标岗位',
    describeJob(job, { withRecruiter: false }),
    '',
    '## 岗位描述（JD）',
    input.jd,
  ].filter(Boolean).join('\n')

  const raw = await requestJson<unknown>(provider, {
    system: buildMatchSystem(opts.userPrompt ?? ''),
    user,
    schemaHint: MATCH_SCHEMA_HINT,
  })

  const result = normalizeMatchResult(raw)
  // 输入被截断时明确标出来，面板会提示「评分可能受影响」
  if (input.truncated)
    result.truncated = true

  return result
}

// ---------------------------------------------------------------------------
// 招呼语生成
// ---------------------------------------------------------------------------

const GREETING_SYSTEM = `你是一位正在求职的候选人，需要给招聘者发一条简短的开场消息。

写作要求：
- 中文，口语化但专业，不要客套话堆砌
- 长度控制在 60-120 字，必须在 200 字以内
- 第一句直接点明你与该岗位最相关的匹配点，不要用「我对贵司的职位很感兴趣」这类空话
- 用具体事实说话：提到的项目/技术/年限必须来自简历原文，不得编造
- 语气自然像真人在聊天，不要用「贵司」「鄙人」这类过于书面的词
- 不要写「期待您的回复」之类的结尾套话`

const GREETING_SCHEMA_HINT = `json 结构：
{
  "greeting": "打招呼内容，60-120 字",
  "rationale": "为什么这样写，一句话，用于向用户解释"
}`

/** BOSS 输入框对超长文本不友好，招呼语硬上限 */
const GREETING_MAX_CHARS = 200

export interface GreetingResult {
  greeting: string
  rationale: string
}

/** 校验并归一化招呼语；缺正文时明确报错，而不是把空串写进账本 */
export function normalizeGreeting(raw: unknown): GreetingResult {
  const data = (raw ?? {}) as Record<string, unknown>

  const greeting = typeof data.greeting === 'string' ? data.greeting.trim() : ''
  if (!greeting)
    throw new Error('模型没有返回招呼语内容（greeting），请重试或更换模型')

  return {
    greeting: greeting.length > GREETING_MAX_CHARS
      ? `${greeting.slice(0, GREETING_MAX_CHARS - 3)}...`
      : greeting,
    rationale: typeof data.rationale === 'string' ? data.rationale.trim() : '',
  }
}

/**
 * 招呼语生成用的 system prompt（含用户自定义规则）。
 *
 * 与 buildMatchSystem 共用拼装逻辑，见上面的 withUserPrompt。
 */
export function buildGreetingSystem(userPrompt: string): string {
  return withUserPrompt(GREETING_SYSTEM, userPrompt)
}

export async function generateGreeting(
  settings: AiSettings,
  resume: Resume,
  job: JobCore,
  jdText: string,
  match: MatchResult | null,
  opts: PromptOptions = {},
): Promise<GreetingResult> {
  const provider = makeProvider(settings)
  const input = fitInputs(provider, resume.markdown, jdText)

  const user = [
    '## 我的简历',
    input.resume,
    '',
    '## 目标岗位',
    // 招呼语是写给招聘者看的，所以这一路要带上招聘者称呼
    describeJob(job, { withRecruiter: true }),
    '',
    '## 岗位描述（JD）',
    input.jd,
    match ? `\n## 匹配分析结论\n${match.summary}\n命中点：${match.reasons.join('；')}` : '',
  ].filter(Boolean).join('\n')

  const raw = await requestJson<unknown>(provider, {
    system: buildGreetingSystem(opts.userPrompt ?? ''),
    user,
    schemaHint: GREETING_SCHEMA_HINT,
  })

  return normalizeGreeting(raw)
}
