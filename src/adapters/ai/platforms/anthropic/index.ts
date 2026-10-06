import { createAnthropicProtocol } from '../../protocols/anthropic'
import { defineAiPlatform } from '../types'

/**
 * Anthropic 官方：x-api-key 鉴权。
 *
 * 无 response_format，结构化输出靠 tool use 强制 —— 由 structured.ts 处理。
 */
export default defineAiPlatform({
  id: 'anthropic',
  providerName: 'Anthropic',
  protocol: createAnthropicProtocol({ authStyle: 'x-api-key' }),
  defaultBaseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-3-5-haiku-latest',
  capabilities: { structuredOutput: 'tool', maxInputChars: 180_000 },
  thinkingToggle: false,
  label: 'Anthropic',
  hint: '长文本、指令遵循强',
})
