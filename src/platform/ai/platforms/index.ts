import type { AiProtocol, AiProvider, AiProviderCapabilities, ProviderConfig } from '../types'
import type { AiPlatformName } from '~/logic/types'
import { createAnthropicProtocol } from '../protocols/anthropic'
import { createOpenAIProtocol } from '../protocols/openai'

/**
 * 平台预设表 + 工厂。
 *
 * 五个平台此前各占一个文件，而文件之间只差 name / baseUrl / model / 能力声明四项，
 * 改一处全局设置要开五个文件。这里改成声明式：新增平台只加一行表项。
 *
 * 协议对象是无状态的，提前建好共用即可（Anthropic 的两种鉴权各一份）。
 */

const DEFAULT_MAX_TOKENS = 2048

const OPENAI_PROTOCOL = createOpenAIProtocol()
const ANTHROPIC_X_API_KEY = createAnthropicProtocol({ authStyle: 'x-api-key' })
const ANTHROPIC_BEARER = createAnthropicProtocol({ authStyle: 'bearer' })

interface PlatformPreset {
  /** 写进连通性测试结果里，让用户确认实际用的是哪家 */
  providerName: string
  protocol: AiProtocol
  defaultBaseUrl: string
  defaultModel: string
  capabilities: AiProviderCapabilities
  /**
   * 是否发送「关闭思考」参数。
   *
   * 只有确实存在思考模式的平台才该发：Anthropic 官方 API 上 `reasoning`
   * 仅对 3.7+ 模型有效，对老模型发送会直接报错。
   */
  thinkingToggle: boolean
  /** 设置页展示用 */
  label: string
  hint: string
}

const PLATFORM_PRESETS: Record<AiPlatformName, PlatformPreset> = {
  /**
   * DeepSeek：OpenAI 兼容 wire 格式。
   *
   * ⚠ 模型名随版本变动，务必以官方文档为准：
   *  - 当前：`deepseek-flash`（DeepSeek-V4.1-Flash）、`deepseek-v4-pro`
   *  - `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停止服务，
   *    用它们会直接报模型不存在
   *
   * ⚠ 自 V4 起**思考模式默认开启**（effort 默认 high）。思考内容会先消耗 token
   * 预算，导致 content 为空、答案只在 reasoning_content 里 —— 这正是
   * 「连接测试正常但回显空」「报模型返回了空内容」的根因。
   * 本项目场景（匹配打分、招呼语生成）都是短输出，因此默认关闭思考。
   *
   * 能力：只有 json_object（无 json_schema），且要求 prompt 中出现 "json" 字样。
   */
  deepseek: {
    providerName: 'DeepSeek',
    protocol: OPENAI_PROTOCOL,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-flash',
    capabilities: { structuredOutput: 'json_object', maxInputChars: 60_000 },
    thinkingToggle: true,
    label: 'DeepSeek',
    hint: '中文场景好、价格低，兼容 OpenAI 格式',
  },

  /** OpenAI：支持最严格的结构化输出（json_schema），可靠性最高 */
  openai: {
    providerName: 'OpenAI',
    protocol: OPENAI_PROTOCOL,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    capabilities: { structuredOutput: 'json_schema', maxInputChars: 100_000 },
    thinkingToggle: false,
    label: 'OpenAI',
    hint: '结构化输出最稳定（json_schema）',
  },

  /**
   * Anthropic 官方：x-api-key 鉴权。
   *
   * 无 response_format，结构化输出靠 tool use 强制 —— 由 structured.ts 处理。
   */
  anthropic: {
    providerName: 'Anthropic',
    protocol: ANTHROPIC_X_API_KEY,
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-3-5-haiku-latest',
    capabilities: { structuredOutput: 'tool', maxInputChars: 180_000 },
    thinkingToggle: false,
    label: 'Anthropic',
    hint: '长文本与指令遵循强',
  },

  /**
   * Kimi（Moonshot）：走 Anthropic 兼容协议，但鉴权用 Authorization: Bearer。
   * 对应官方 ANTHROPIC_AUTH_TOKEN 的用法。
   */
  kimi: {
    providerName: 'Kimi',
    protocol: ANTHROPIC_BEARER,
    defaultBaseUrl: 'https://api.kimi.com/coding',
    defaultModel: 'k3',
    capabilities: { structuredOutput: 'prompt', maxInputChars: 120_000 },
    thinkingToggle: false,
    label: 'Kimi',
    hint: 'Anthropic 兼容协议 + Bearer 鉴权',
  },

  /**
   * 自定义 OpenAI 兼容端点：中转站、自建网关、本地模型（Ollama / LM Studio /
   * one-api 之类）都走这里。baseUrl 与 model 必填，能力按最保守声明。
   *
   * 用本地模型可以做到简历与 JD 完全不出本机。
   */
  custom: {
    providerName: 'Custom',
    protocol: OPENAI_PROTOCOL,
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModel: '',
    capabilities: { structuredOutput: 'prompt', maxInputChars: 32_000 },
    thinkingToggle: false,
    label: '自定义端点',
    hint: '中转站 / 自建网关 / 本地模型',
  },
}

/** 平台工厂：按名字选定预设，并用用户配置覆盖默认地址 / 模型 */
export function createAiProvider(
  name: AiPlatformName,
  config: ProviderConfig,
): AiProvider {
  const preset = PLATFORM_PRESETS[name]
  if (!preset)
    throw new Error(`Unknown AI platform: ${name}`)

  return {
    name: preset.providerName,
    protocol: preset.protocol,
    capabilities: preset.capabilities,
    config: {
      baseUrl: config.baseUrl || preset.defaultBaseUrl,
      apiKey: config.apiKey,
      model: config.model || preset.defaultModel,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: config.thinking ?? false,
      thinkingToggle: preset.thinkingToggle,
    },
  }
}

/** 供设置页展示的可选平台清单（顺序即展示顺序） */
export const AI_PLATFORM_OPTIONS = (
  Object.keys(PLATFORM_PRESETS) as AiPlatformName[]
).map(value => ({
  value,
  label: PLATFORM_PRESETS[value].label,
  hint: PLATFORM_PRESETS[value].hint,
}))

export type { AiProvider, AiProviderCapabilities } from '../types'
