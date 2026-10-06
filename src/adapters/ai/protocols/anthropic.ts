import type {
  AiProtocol,
  ResolvedConfig,
} from '../types'
import { requestWithTimeout } from '~/platform/http'
import { createChatRunner } from './chat'
import {
  AI_PING_TIMEOUT_MS,
  AI_REQUEST_TIMEOUT_MS,
  stripTrailingSlash,
} from './http'

/**
 * Anthropic 兼容协议：POST {baseUrl}/v1/messages
 *
 * 两个坑：
 *  1. system prompt 是顶层字段，不放进 messages
 *  2. 鉴权方式有两种：官方 x-api-key，Kimi 等兼容端用 Authorization: Bearer
 */

export interface AnthropicProtocolOptions {
  authStyle?: 'x-api-key' | 'bearer'
}

/**
 * 生成思考模式相关的请求参数。
 *
 * Anthropic 格式用 `reasoning.effort`，`none` 表示关闭。
 * 与本项目其他协议一致：默认关闭思考，避免推理链吃掉 token 预算导致正文为空。
 *
 * 仅当 config.thinkingToggle 为真时才发送 —— Anthropic 官方 API 上
 * `reasoning` 只对 3.7+ 模型有效，对老模型发送会直接报错。
 */
function thinkingParams(config: ResolvedConfig): Record<string, unknown> {
  if (!config.thinkingToggle)
    return {}
  return { reasoning: { effort: config.thinking ? 'high' : 'none' } }
}

/**
 * 从 Anthropic 风格响应里抽出文本内容。
 *
 * ⚠ 只认 `type: 'text'` 的块：thinking 块与 tool_use 块都不是正文，混进来会污染
 *   JSON 解析（也让「输出被截断」这类诊断失效）。
 */
export function extractAnthropicText(raw: unknown): string {
  const data = raw as any
  if (!Array.isArray(data?.content))
    return ''
  return data.content
    .map((block: any) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/**
 * 响应没有正文时给可诊断的原因。
 *
 * Anthropic 用 `stop_reason` 表达结束原因，其中 `max_tokens` 是最常见的一种：
 * 思考模式会先把预算烧完，于是 `content` 里一块文本都没有。
 */
export function describeAnthropicEmpty(raw: unknown): string {
  const stop = (raw as any)?.stop_reason ?? '(未知)'
  if (stop === 'max_tokens')
    return '输出被 max_tokens 截断：思考模式消耗了全部预算、未产出正文，请调大最大输出 Token 或关闭思考模式'
  return `模型没有返回正文（stop_reason=${stop}）`
}

export function createAnthropicProtocol(
  opts: AnthropicProtocolOptions = {},
): AiProtocol {
  const authStyle = opts.authStyle ?? 'x-api-key'

  function buildHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (authStyle === 'bearer')
      headers.Authorization = `Bearer ${apiKey}`
    else
      headers['x-api-key'] = apiKey
    return headers
  }

  const { runChat, runPing } = createChatRunner(
    {
      build(req, config, ping) {
        return {
          url: `${stripTrailingSlash(config.baseUrl)}/v1/messages`,
          headers: buildHeaders(config.apiKey),
          body: ping
            ? {
                model: config.model,
                max_tokens: 64,
                messages: [{ role: 'user', content: '回复 ok' }],
                ...thinkingParams(config),
              }
            : {
                model: config.model,
                max_tokens: config.maxTokens,
                system: req.system,
                messages: req.messages
                  // Anthropic 不接受 system role 出现在 messages 里
                  .filter(m => m.role !== 'system')
                  .map(m => ({ role: m.role, content: m.content })),
                ...thinkingParams(config),
              },
        }
      },
      textOf: extractAnthropicText,
      describeEmpty: describeAnthropicEmpty,
    },
    { chat: AI_REQUEST_TIMEOUT_MS, ping: AI_PING_TIMEOUT_MS },
    requestWithTimeout,
  )

  return {
    name: 'anthropic',
    chat: runChat,
    ping: runPing,
  }
}
