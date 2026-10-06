/**
 * AI 协议层类型：定义 wire 格式（请求体/响应体长什么样）。
 *
 * 分三层（protocol → platform → factory）：
 *   protocol  只关心 wire 格式（OpenAI /chat/completions、Anthropic /v1/messages）
 *   platform  由 platforms/index.ts 的声明式预设表选定协议 + 声明平台能力
 *   factory   按平台名构造 provider
 *
 * 默认地址 / 默认模型 / 超时这类「每个平台一份的常量」全部收敛在预设表里，
 * 协议层不再各自重复声明一份（重复的那份从来没人读）。
 */

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatRequest {
  system: string
  messages: ChatMessage[]
  /** 要求模型只输出 JSON */
  json?: boolean
}

/** 各协议统一返回纯文本内容；JSON 解析交给上层，错误信息带上下文更易排查 */
export interface ChatResponse {
  text: string
  raw: unknown
}

export interface AiProtocol {
  readonly name: string
  chat: (req: ChatRequest, config: ResolvedConfig) => Promise<ChatResponse>
  /**
   * 最小连通性探测：发一个极短的请求，验证地址 / Key / 模型名三者都对。
   *
   * 刻意不复用 chat()：chat 会带上完整的 system + messages 与业务参数，
   * 任何一个配置错误都会混在一起难以定位；探测要的是「网络与鉴权是否通」。
   */
  ping: (config: ResolvedConfig) => Promise<PingResult>
}

export interface PingResult {
  ok: boolean
  /** 成功时返回模型的回显文本，用于确认模型确实可用 */
  reply?: string
  error?: string
  /** 往返耗时（毫秒） */
  latencyMs?: number
}

export interface ProviderConfig {
  baseUrl?: string
  apiKey: string
  model?: string
  maxTokens?: number
  /**
   * 是否启用思考模式（推理链）。
   *
   * 对 DeepSeek 这类「默认开启思考」的平台，必须显式关闭才能用于结构化抽取：
   * 思考会先消耗 token 预算，导致 content 为空、答案全在 reasoning_content 里。
   *
   * 默认 false —— 本项目的场景（匹配打分、招呼语生成）都是短输出，
   * 思考带来的收益远不及「输出为空」的代价。
   */
  thinking?: boolean
}

export interface ResolvedConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  thinking: boolean
  /**
   * 是否允许发送「关闭思考」的参数。
   *
   * 只有确实存在思考模式的平台才该发：Anthropic 官方 API 上
   * `reasoning` 仅对 3.7+ 模型有效，对老模型发送会直接报错。
   */
  thinkingToggle: boolean
}

/**
 * 平台能力声明。上层（structured.ts / matching.ts）只读这些能力来决定策略，
 * 不关心底下是哪家。
 */
export interface AiProviderCapabilities {
  /**
   * 这家平台能不能**按 schema 输出 JSON**。
   *
   * ⚠ 这里刻意是布尔而不是「用了哪种机制」的枚举：`json_schema`（OpenAI）、
   *   `json_object`（DeepSeek）、tool use（Anthropic）是**同一种能力的三家实现**，
   *   而「纯靠 prompt 约束」是**没有这种能力**。此前枚举把它们并列，于是
   *   `structuredOutput: 'tool'` 变成一个悬空的承诺 —— 上层只认其中两个值，
   *   而 Anthropic 协议也从没接过 tool use，注释与实现长期不一致。
   *
   *   选哪种机制是**各协议自己的事**（OpenAI 协议发 `response_format`，
   *   Anthropic 协议将来要发 `tools` 也是它自己的选择），契约只回答「有没有」。
   */
  nativeJson: boolean
  /**
   * 单次请求可接受的最大输入字符数。
   *
   * 必须被真正使用（见 matching.ts 的 fitInputs）：简历 + JD 原样拼接时，
   * 一份长简历（尤其将来支持 PDF 导入后）会直接撞上下文上限。
   */
  maxInputChars: number
}

export interface AiProvider {
  readonly name: string
  readonly protocol: AiProtocol
  readonly capabilities: AiProviderCapabilities
  readonly config: ResolvedConfig
}
