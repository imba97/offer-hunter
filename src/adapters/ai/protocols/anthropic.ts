import type {
  AiProtocol,
  ChatRequest,
  ChatResponse,
  PingResult,
  ResolvedConfig,
} from '../types'
import { fetchWithTimeout } from '~/platform/http'
import {
  AI_PING_TIMEOUT_MS,
  AI_REQUEST_TIMEOUT_MS,
  responseErrorDetail,
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

/** 从 Anthropic 风格响应里抽出文本内容 */
export function extractAnthropicText(raw: unknown): string {
  const data = raw as any
  if (!Array.isArray(data?.content))
    return ''
  return data.content
    .map((block: any) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
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

  return {
    name: 'anthropic',

    async ping(config: ResolvedConfig): Promise<PingResult> {
      const started = Date.now()
      const url = `${stripTrailingSlash(config.baseUrl)}/v1/messages`
      try {
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: buildHeaders(config.apiKey),
          body: JSON.stringify({
            model: config.model,
            max_tokens: 64,
            messages: [{ role: 'user', content: '回复 ok' }],
            ...thinkingParams(config),
          }),
        }, AI_PING_TIMEOUT_MS)

        const raw = await res.json().catch(() => null)
        const latencyMs = Date.now() - started

        if (!res.ok)
          return { ok: false, error: responseErrorDetail(raw, res.status), latencyMs }

        const reply = extractAnthropicText(raw).trim()
        if (!reply) {
          const stop = (raw as any)?.stop_reason ?? '(未知)'
          return {
            ok: false,
            error: stop === 'max_tokens'
              ? '输出被 max_tokens 截断：思考模式消耗了全部预算、未产出正文，请调大最大输出 Token 或关闭思考模式'
              : `模型没有返回正文（stop_reason=${stop}）`,
            latencyMs,
          }
        }

        return { ok: true, reply, latencyMs }
      }
      catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          latencyMs: Date.now() - started,
        }
      }
    },

    async chat(req: ChatRequest, config: ResolvedConfig): Promise<ChatResponse> {
      const res = await fetchWithTimeout(`${stripTrailingSlash(config.baseUrl)}/v1/messages`, {
        method: 'POST',
        headers: buildHeaders(config.apiKey),
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens,
          system: req.system,
          messages: req.messages
            // Anthropic 不接受 system role 出现在 messages 里
            .filter(m => m.role !== 'system')
            .map(m => ({ role: m.role, content: m.content })),
          ...thinkingParams(config),
        }),
      }, AI_REQUEST_TIMEOUT_MS)

      const raw = await res.json().catch(() => null)

      if (!res.ok)
        throw new Error(`[${config.model}] ${responseErrorDetail(raw, res.status)}`)

      const text = extractAnthropicText(raw)
      // 与 OpenAI 协议保持一致：空正文在这里就报错，而不是让上层拿到空字符串
      if (!text.trim())
        throw new Error(`[${config.model}] 模型没有返回正文（stop_reason=${(raw as any)?.stop_reason ?? '(未知)'}）`)

      return { text, raw }
    },
  }
}
