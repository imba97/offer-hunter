import type { AiProtocol, AiProviderCapabilities } from '../types'

/**
 * 一个 AI 平台的**声明**。
 *
 * 此前这些东西集中在一张 `PLATFORM_PRESETS` 表里（platforms/index.ts），加一家平台
 * 要改那个文件；现在每个平台一个目录 + 一个 `index.ts`，注册表按目录约定 glob 它们。
 *
 * 协议对象由各平台自己建（`createOpenAIProtocol()` 之类）：它们是无状态的，
 * 一份实例可以共用，但**在哪建**这件事跟着平台走，表里就不再需要 `protocol` 字段了。
 */
export interface AiPlatformDefinition {
  /**
   * 平台标识，必须与 `platform/ai/platforms/<id>/` 目录名一致
   * （设置页按它存 `AiSettings.platform`，改了会让用户的配置指向一个不存在的平台）。
   */
  id: string
  /** 写进连通性测试结果里，让用户确认实际用的是哪家 */
  providerName: string
  /** wire 格式处理器（各平台自己 new 一个，见上） */
  protocol: AiProtocol
  /** 接口地址留空时用的地址 */
  defaultBaseUrl: string
  /** 模型名留空时用的模型 */
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

/**
 * 声明一个 AI 平台。
 *
 * 与站点那套的 `defineSite()` 同形：每个平台目录的 `index.ts` 都写成
 * `export default defineAiPlatform({ … })`，注册表据此按目录约定 glob 它们。
 * 运行时不做任何加工，只给类型与写法一个统一落点。
 */
export function defineAiPlatform(platform: AiPlatformDefinition): AiPlatformDefinition {
  return platform
}
