import type { AiProvider, ChatMessage } from './types'

/**
 * 结构化输出的策略选择。
 *
 * 上层只要「给我一个 T」，由这里根据 provider.capabilities 决定怎么要：
 *  - json_object：请求体带 response_format，并确保 prompt 出现 "json"
 *    （DeepSeek 官方要求，否则可能返回空对象）
 *  - json_schema / tool / prompt：当前实现统一退化为 prompt 约束 + 容错解析。
 *    各家的严格模式 wire 格式差异较大，留待需要时在 adapter 内补齐。
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

export async function requestJson<T>(
  provider: AiProvider,
  opts: JsonRequestOptions,
): Promise<T> {
  const capabilities = provider.capabilities
  const useJsonMode = capabilities.structuredOutput === 'json_object'
    || capabilities.structuredOutput === 'json_schema'

  // DeepSeek 等平台要求 prompt 中出现 "json" 字样才会启用 JSON 输出。
  // 这里统一加上，无害且必要。
  const system = [
    opts.system,
    '',
    '输出要求：',
    '- 只输出一个合法的 json 对象，不要输出任何解释性文字',
    '- 不要用 markdown 代码块包裹',
    opts.schemaHint,
  ].join('\n')

  const messages: ChatMessage[] = [{ role: 'user', content: opts.user }]

  const res = await provider.protocol.chat(
    { system, messages, json: useJsonMode },
    provider.config,
  )

  return parseJsonLoose<T>(res.text)
}
