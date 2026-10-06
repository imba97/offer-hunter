import type { AiProvider, ProviderConfig } from '../types'
import type { AiPlatformDefinition } from './types'

/**
 * AI 平台注册表 + 工厂。
 *
 * **新增一家平台 = 加一个 `platforms/<id>/` 目录（`index.ts` 里默认导出
 * `defineAiPlatform(...)`），然后什么都不用改** —— 本文件按目录约定 glob 它们，
 * 设置页的下拉框也从这里读。
 *
 * 与站点那套的分工完全同构：目录约定 + 默认导出，注册表只负责聚合与查表。
 */

const DEFAULT_MAX_TOKENS = 2048

/** 全部平台声明，按目录路径排序（顺序即设置页下拉框的展示顺序） */
export const AI_PLATFORMS: AiPlatformDefinition[] = Object.entries(
  import.meta.glob<{ default: AiPlatformDefinition }>('./*/index.ts', { eager: true }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, mod]) => mod.default)

/** 按 id 取平台声明；未知 id 返回 undefined */
export function getAiPlatform(id: string): AiPlatformDefinition | undefined {
  return AI_PLATFORMS.find(platform => platform.id === id)
}

/** 平台工厂：按名字选定声明，并用用户配置覆盖默认地址 / 模型 */
export function createAiProvider(
  name: string,
  config: ProviderConfig,
): AiProvider {
  const platform = getAiPlatform(name)
  if (!platform) {
    // 拼错 id 由测试兜底，但存储里可能残留已废弃的平台名 —— 那种情况要说清是哪来的
    throw new Error(`Unknown AI platform: ${name}`)
  }

  return {
    name: platform.providerName,
    protocol: platform.protocol,
    capabilities: platform.capabilities,
    config: {
      baseUrl: config.baseUrl || platform.defaultBaseUrl,
      apiKey: config.apiKey,
      model: config.model || platform.defaultModel,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: config.thinking ?? false,
      thinkingToggle: platform.thinkingToggle,
    },
  }
}

/** 供设置页展示的可选平台清单（顺序即展示顺序） */
export const AI_PLATFORM_OPTIONS = AI_PLATFORMS.map(platform => ({
  value: platform.id,
  label: platform.label,
  hint: platform.hint,
  /** 接口地址留空时实际会用的地址，设置页直接显示它，省得用户去翻文档 */
  defaultBaseUrl: platform.defaultBaseUrl,
}))

export type { AiProvider, AiProviderCapabilities } from '../types'
export type { AiPlatformDefinition } from './types'
