import { createAnthropicProtocol } from '../../protocols/anthropic'
import { defineAiPlatform } from '../types'

/**
 * Anthropic 官方：x-api-key 鉴权。
 *
 * ⚠ Anthropic **没有** OpenAI 那种 `response_format`，而它的 tool use 也还没接
 *   （协议层不发 `tools`，响应也不解析 `tool_use`）。所以这里如实声明
 *   `nativeJson: false` —— 结构化输出完全靠 prompt 约束 + 容错解析。
 *   要接 tool use 时改的是 `protocols/anthropic.ts`，契约不必动。
 */
export default defineAiPlatform({
  id: 'anthropic',
  providerName: 'Anthropic',
  protocol: createAnthropicProtocol({ authStyle: 'x-api-key' }),
  defaultBaseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-3-5-haiku-latest',
  capabilities: { nativeJson: false, maxInputChars: 180_000 },
  thinkingToggle: false,
  label: 'Anthropic',
  hint: '长文本、指令遵循强',
})
