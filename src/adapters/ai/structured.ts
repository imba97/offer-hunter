import type { AiProvider, ChatMessage } from './types'

/**
 * 结构化输出的策略选择。
 *
 * 上层只要「给我一个 T」，由这里根据 provider.capabilities 决定怎么要：
 *  - `nativeJson: true`：让协议去用它自己那套原生结构化输出（OpenAI 发
 *    `response_format: json_object`、DeepSeek 同理）。无论走哪家，prompt 里都会
 *    带上 "json" 字样 —— DeepSeek 官方要求如此，否则可能返回空对象。
 *  - `nativeJson: false`：纯靠 prompt 约束 + 容错解析。
 *
 * ⚠ 契约只回答「这家平台有没有原生 JSON 输出」；**用哪种机制是各协议的内部事**
 *   （见 types.ts 的 AiProviderCapabilities.nativeJson）。
 */

export interface JsonRequestOptions {
  system: string
  user: string
  /** 说明期望的 JSON 结构，会拼进 prompt */
  schemaHint: string
}

/**
 * 容错解析模型返回的 JSON：
 * 模型经常会在 JSON 外包一层 ```json 代码块，或前后带解释性文字。
 */
export function parseJsonLoose<T>(text: string): T {
  const trimmed = text.trim()
  if (!trimmed)
    throw new Error('模型返回了空内容')

  // 直接尝试
  try {
    return JSON.parse(trimmed) as T
  }
  catch {
    // 继续尝试剥离
  }

  // 剥离 ```json ... ``` 代码块。
  // 这里刻意不用正则：/```(?:json)?\s*([\s\S]*?)```/ 存在多项式回溯风险。
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n')
    const fenceEnd = trimmed.indexOf('```', 3)
    if (firstNewline !== -1 && fenceEnd > firstNewline) {
      try {
        return JSON.parse(trimmed.slice(firstNewline + 1, fenceEnd).trim()) as T
      }
      catch {
        // 继续尝试
      }
    }
  }

  // 截取第一个 { 到最后一个 }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T
    }
    catch {
      // 落到下面抛错
    }
  }

  throw new Error(`无法从模型返回中解析出 JSON：${trimmed.slice(0, 200)}`)
}

/**
 * 拼出最终发给模型的 system prompt（含 JSON 输出要求）。
 *
 * DeepSeek 等平台要求 prompt 中出现 "json" 字样才会启用 JSON 输出。这里统一加上，
 * 无害且必要。
 */
export function buildJsonSystem(opts: Pick<JsonRequestOptions, 'system' | 'schemaHint'>): string {
  return [
    opts.system,
    '',
    '输出要求：',
    '- 只输出一个合法的 json 对象，不要输出任何解释性文字',
    '- 不要用 markdown 代码块包裹',
    opts.schemaHint,
  ].join('\n')
}

/**
 * 这次请求里**与简历 / JD 内容无关**的固定字符数：system、消息包装，以及空消息
 * 本身占位的字符。
 *
 * 存在的意义：调用方要按平台的 `maxInputChars` 裁剪简历与 JD，而预算必须扣掉这些
 * 固定开销 —— 否则「用户把自定义提示词写得很长」这件事完全不进预算，裁剪结果照样超限。
 *
 * ⚠ 让这个函数**报告真实开销**，而不是在调用方那边估一个常量：估出来的常量会随着
 *   system 文案改动静默失准（此前 matching.ts 里那个 `PROMPT_RESERVE = 2000` 就是
 *   这么来的）。
 *
 * `placeholderChars` 是调用方在「空载荷」里放的占位字符数（例如用 `（无）` 顶替简历
 * 与 JD 各一处）——真实载荷长度由调用方自己扣掉，占位本身不是固定开销，所以要减掉。
 */
export function jsonRequestOverhead(
  opts: Pick<JsonRequestOptions, 'system' | 'schemaHint'>,
  emptyUserChars: number,
  placeholderChars = 0,
): number {
  return buildJsonSystem(opts).length + emptyUserChars - placeholderChars
}

export async function requestJson<T>(
  provider: AiProvider,
  opts: JsonRequestOptions,
): Promise<T> {
  const capabilities = provider.capabilities
  // 有原生 JSON 输出就打开它；没有则完全靠下面的 prompt 约束 + 容错解析
  const useJsonMode = capabilities.nativeJson

  const system = buildJsonSystem(opts)

  const messages: ChatMessage[] = [{ role: 'user', content: opts.user }]

  const res = await provider.protocol.chat(
    { system, messages, json: useJsonMode },
    provider.config,
  )

  return parseJsonLoose<T>(res.text)
}
