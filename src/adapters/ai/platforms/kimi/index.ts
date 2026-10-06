import { createAnthropicProtocol } from '../../protocols/anthropic'
import { defineAiPlatform } from '../types'

/**
 * Kimi（Moonshot）：走 Anthropic 兼容协议，但鉴权用 Authorization: Bearer。
 * 对应官方 ANTHROPIC_AUTH_TOKEN 的用法。
 */
export default defineAiPlatform({
  id: 'kimi',
  providerName: 'Kimi',
  protocol: createAnthropicProtocol({ authStyle: 'bearer' }),
  defaultBaseUrl: 'https://api.kimi.com/coding',
  defaultModel: 'k3',
  capabilities: { structuredOutput: 'prompt', maxInputChars: 120_000 },
  thinkingToggle: false,
  label: 'Kimi',
  hint: '月之暗面出品，长上下文',
})
