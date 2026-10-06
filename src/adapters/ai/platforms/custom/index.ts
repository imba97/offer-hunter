import { createOpenAIProtocol } from '../../protocols/openai'
import { defineAiPlatform } from '../types'

/**
 * 自定义 OpenAI 兼容端点：中转站、自建网关、本地模型（Ollama / LM Studio /
 * one-api 之类）都走这里。baseUrl 与 model 必填，能力按最保守声明。
 *
 * 用本地模型可以做到简历与 JD 完全不出本机。
 */
export default defineAiPlatform({
  id: 'custom',
  providerName: 'Custom',
  protocol: createOpenAIProtocol(),
  defaultBaseUrl: 'http://localhost:11434/v1',
  defaultModel: '',
  capabilities: { structuredOutput: 'prompt', maxInputChars: 32_000 },
  thinkingToggle: false,
  label: '自定义端点',
  hint: '中转站 / 自建网关 / 本地模型',
})
