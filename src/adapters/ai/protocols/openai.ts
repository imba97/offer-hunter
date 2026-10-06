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
 * OpenAI 兼容协议：POST {baseUrl}/chat/completions
 *
 * DeepSeek / 各类中转站都兼容这套 wire 格式。
 */

/**
 * 生成思考模式相关的请求参数。
 *
 * DeepSeek 自 V4 起**默认开启思考模式**（effort 默认 high），思考内容会先消耗
 * token 预算，导致 content 为空、答案全在 reasoning_content 里 —— 这正是
 * 「连接正常但回显空 / 报模型返回了空内容」的根因。
 * 通过 `{"thinking": {"type": "disabled"}}` 关闭。
 *
 * 仅当 config.thinkingToggle 为真时才发送：多数 OpenAI 兼容平台没有思考模式，
 * 发未知字段虽然一般会被忽略，但没必要冒险。
 */
function thinkingParams(config: ResolvedConfig): Record<string, unknown> {
  if (!config.thinkingToggle)
    return {}
  return { thinking: { type: config.thinking ? 'enabled' : 'disabled' } }
}

/**
 * 从 OpenAI 风格响应里抽出文本内容。
 *
 * 兼顾两种「content 为空但实际有输出」的情况：
 *  1. 多模态风格的数组形式 content 片段
 *  2. 思考模式把内容放进 message.reasoning_content（DeepSeek 的已知行为）
 *
 * ⚠ 回退到 reasoning_content 有严格前提：**仅在正常结束（finish_reason != 'length'）
 * 时才回退**。被 max_tokens 截断时 reasoning_content 里是「未完成的思考过程」而不是
 * 答案，把它当正文返回会静默产出垃圾 —— 那种情况必须报错。
 */
export function extractOpenAIText(raw: unknown): string {
  const data = raw as any
  const choice = data?.choices?.[0]
  if (!choice)
    return ''

  const message = choice.message
  const finish = choice.finish_reason ?? choice.finishReason

  // 标准字段优先
  if (typeof message?.content === 'string' && message.content.trim().length > 0)
    return message.content
  // 数组形式的内容片段
  if (Array.isArray(message?.content)) {
    const joined = message.content
      .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
    if (joined.trim().length > 0)
      return joined
  }
  // 兼容 completion 风格
  if (typeof choice.text === 'string' && choice.text.trim().length > 0)
    return choice.text

  // 被截断时 reasoning_content 是未完成的思考，不能当答案
  if (finish === 'length')
    return ''

  // 正常结束却 content 为空：回退到推理链内容
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim().length > 0)
    return message.reasoning_content

  return ''
}

/** 让上层能区分「真的没输出」和「输出去哪了」，用于给出可诊断的报错 */
export function describeEmptyResponse(raw: unknown): string {
  const data = raw as any
  const choice = data?.choices?.[0]
  if (!choice)
    return '响应里没有 choices，可能是模型名无效或接口地址不对'

  const finish = choice.finish_reason ?? choice.finishReason ?? '(未知)'
  const hasReasoning = typeof choice.message?.reasoning_content === 'string'

  if (finish === 'length') {
    return hasReasoning
      ? '输出被 max_tokens 截断：思考模式消耗了全部 token 预算，未产出正文。请调大「最大输出 Token」，或关闭思考模式'
      : '输出被 max_tokens 截断，请调大「最大输出 Token」'
  }
  if (finish === 'content_filter')
    return '内容被平台安全过滤'
  return `模型没有返回正文（finish_reason=${finish}）`
}

export function createOpenAIProtocol(): AiProtocol {
  return {
    name: 'openai',

    async ping(config: ResolvedConfig): Promise<PingResult> {
      const started = Date.now()
      const url = `${stripTrailingSlash(config.baseUrl)}/chat/completions`
      try {
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            // 给足预算：思考模式即使关闭，部分平台仍会残留少量推理 token
            max_tokens: 64,
            messages: [{ role: 'user', content: '回复 ok' }],
            ...thinkingParams(config),
          }),
        }, AI_PING_TIMEOUT_MS)

        const raw = await res.json().catch(() => null)
        const latencyMs = Date.now() - started

        if (!res.ok)
          return { ok: false, error: responseErrorDetail(raw, res.status), latencyMs }

        const reply = extractOpenAIText(raw).trim()
        if (!reply) {
          // 连通性没问题但没正文：给出可诊断的原因，而不是含糊的「空回复」
          return { ok: false, error: describeEmptyResponse(raw), latencyMs }
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
      const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: config.maxTokens,
        messages: [
          { role: 'system', content: req.system },
          ...req.messages.map(m => ({ role: m.role, content: m.content })),
        ],
        ...thinkingParams(config),
      }

      // json_object 只保证合法 JSON，不保证 schema。
      // ⚠ DeepSeek 要求 prompt 中出现 "json" 字样，否则可能返回空对象，
      // 因此调用方（structured.ts）必须确保 system prompt 含该词。
      if (req.json)
        body.response_format = { type: 'json_object' }

      const res = await fetchWithTimeout(`${stripTrailingSlash(config.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      }, AI_REQUEST_TIMEOUT_MS)

      const raw = await res.json().catch(() => null)

      if (!res.ok)
        throw new Error(`[${config.model}] ${responseErrorDetail(raw, res.status)}`)

      const text = extractOpenAIText(raw)
      if (!text.trim())
        throw new Error(`[${config.model}] ${describeEmptyResponse(raw)}`)

      return { text, raw }
    },
  }
}
