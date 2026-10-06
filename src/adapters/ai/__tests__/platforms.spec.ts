import { describe, expect, it } from 'vitest'
import { AI_PLATFORM_OPTIONS, AI_PLATFORMS, createAiProvider, getAiPlatform } from '../platforms'

/**
 * AI 平台注册表的测试。
 *
 * 钉住的是**自动索引这条约定**：`platforms/<id>/index.ts` 默认导出
 * `defineAiPlatform(...)`，注册表按目录约定收进来；设置页下拉框与工厂都从这里读。
 *
 * 闭合的字面量联合被换成了开放字符串（`AiPlatformName = string`），因此
 * 「id 与目录名一致」「id 不重复」这两条以前由类型系统兜的，现在由这里兜。
 */

const PLATFORM_ENTRIES = Object.entries(
  import.meta.glob<{ default: { id: string } }>('../platforms/*/index.ts', { eager: true }),
)

describe('自动索引（glob 约定）', () => {
  it('每个平台目录都被索引到，且适配器声明的 id 与目录同名', () => {
    expect(PLATFORM_ENTRIES.length).toBeGreaterThan(0)

    for (const [key, mod] of PLATFORM_ENTRIES) {
      const dir = key.replace(/^\.\.\/platforms\//, '').split('/')[0]
      expect(mod.default.id, key).toBe(dir)
    }

    expect(AI_PLATFORMS.map(platform => platform.id).sort())
      .toEqual(PLATFORM_ENTRIES.map(([key]) => key.replace(/^\.\.\/platforms\//, '').split('/')[0]).sort())
  })

  it('id 唯一（重复会让工厂静默取到前一个）', () => {
    const ids = AI_PLATFORMS.map(platform => platform.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个平台都声明完整（名字 / 地址 / 模型 / 能力 / 展示文案）', () => {
    for (const platform of AI_PLATFORMS) {
      expect(platform.providerName.length, platform.id).toBeGreaterThan(0)
      expect(platform.defaultBaseUrl).toMatch(/^https?:\/\//)
      expect(platform.label.length, platform.id).toBeGreaterThan(0)
      expect(platform.hint.length, platform.id).toBeGreaterThan(0)
      expect(platform.capabilities.maxInputChars, platform.id).toBeGreaterThan(0)
      // 能力只有一个布尔：这家平台有没有原生 JSON 输出
      expect(typeof platform.capabilities.nativeJson, platform.id).toBe('boolean')
    }
  })

  it('下拉框选项由注册表派生（顺序一致，不多不少）', () => {
    expect(AI_PLATFORM_OPTIONS.map(o => o.value)).toEqual(AI_PLATFORMS.map(p => p.id))
    for (const option of AI_PLATFORM_OPTIONS)
      expect(option.defaultBaseUrl).toBe(getAiPlatform(option.value)?.defaultBaseUrl)
  })
})

describe('createAiProvider', () => {
  it('用户没填地址 / 模型时用平台的默认值', () => {
    const provider = createAiProvider('openai', { apiKey: 'sk-1' })
    const platform = getAiPlatform('openai')!

    expect(provider.config.baseUrl).toBe(platform.defaultBaseUrl)
    expect(provider.config.model).toBe(platform.defaultModel)
    expect(provider.config.maxTokens).toBe(2048)
    expect(provider.config.thinkingToggle).toBe(platform.thinkingToggle)
  })

  it('用户填了就覆盖默认值', () => {
    const provider = createAiProvider('custom', { apiKey: 'sk-1', baseUrl: 'http://x/v1', model: 'm' })

    expect(provider.config.baseUrl).toBe('http://x/v1')
    expect(provider.config.model).toBe('m')
  })

  it('未知平台名抛错（存储里可能残留已删掉的平台）', () => {
    expect(() => createAiProvider('已被删掉的平台', { apiKey: 'sk-1' })).toThrow('Unknown AI platform')
  })
})
