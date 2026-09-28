import type { JobRecord } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { mergeDefaults, stripRemovedRecordFields } from '../storage'
import { createDefaultAiSettings, createDefaultMatchingSettings, createEmptyResume } from '../types'

/**
 * webextension-polyfill 在 jsdom 里没有 chrome.* 可用，import 时就会抛错。
 * 这里只测纯函数（迁移逻辑），把存储 API 换成假的即可 —— vi.mock 会被提升到
 * import 之前，所以下面的静态 import 拿到的是 mock 版本。
 */
vi.mock('webextension-polyfill', () => ({
  storage: {
    local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
}))

/**
 * 存储迁移的单测。
 *
 * mergeDefaults 出错时的症状离原因很远（例如设置页读 apiKey.trim() 抛
 * "Cannot read properties of undefined"），因此值得把边界固定下来。
 */

describe('mergeDefaults', () => {
  it('补齐缺失字段（旧版本存储格式）', () => {
    const merged = mergeDefaults({ apiKey: 'sk-1' }, createDefaultAiSettings())

    expect(merged).toEqual({
      platform: 'deepseek',
      baseUrl: '',
      apiKey: 'sk-1',
      model: '',
      maxTokens: 2048,
    })
  })

  it('丢掉默认值里已不存在的字段（旧数据不再被写回）', () => {
    const merged = mergeDefaults(
      { markdown: '# 我', sourceId: null, updatedAt: null, basics: { city: '上海' } },
      createEmptyResume(),
    )

    expect(merged).toEqual({ markdown: '# 我', sourceId: null, updatedAt: null })
    expect('basics' in merged).toBe(false)
  })

  it('把早期被 JSON 字符串化的数据还原成对象', () => {
    const legacy = JSON.stringify({ greetingPrompt: '开头用您好' })
    const merged = mergeDefaults(legacy, createDefaultMatchingSettings())

    expect(merged).toEqual({ greetingPrompt: '开头用您好' })
  })

  it('字符串不是对象时不解析（避免把普通文本当成 JSON）', () => {
    expect(mergeDefaults('随便一段文本', '默认')).toBe('随便一段文本')
  })

  it('存储里没有值（undefined / null）时用默认值', () => {
    expect(mergeDefaults(undefined, createDefaultAiSettings())).toEqual(createDefaultAiSettings())
    expect(mergeDefaults(null, createDefaultAiSettings())).toEqual(createDefaultAiSettings())
  })

  it('动态键映射（账本）不做裁剪，否则整张表会被清空', () => {
    const records = { a: { securityId: 'a' }, b: { securityId: 'b' } }
    expect(mergeDefaults(records, {})).toEqual(records)
  })

  it('数组按存储为准，类型不符时退回默认值', () => {
    expect(mergeDefaults(['x'], ['default'])).toEqual(['x'])
    expect(mergeDefaults('not-array', ['default'])).toEqual(['default'])
  })

  it('嵌套对象逐层合并', () => {
    const merged = mergeDefaults({ a: { b: 2 } }, { a: { b: 1, c: 3 } })
    expect(merged).toEqual({ a: { b: 2, c: 3 } })
  })
})

/**
 * 账本迁移：mergeDefaults 对动态键映射不做裁剪，所以被删掉的字段（status）
 * 只能靠这个函数抹掉，否则会永远跟着存量数据写回存储。
 */
describe('stripRemovedRecordFields', () => {
  it('抹掉已删除的 status，并报告发生了改动', () => {
    const records = {
      a: { securityId: 'a', status: 'skipped', jobName: '前端' },
      b: { securityId: 'b', status: 'drafted' },
      c: { securityId: 'c' },
    } as unknown as Record<string, JobRecord>

    expect(stripRemovedRecordFields(records)).toBe(true)
    // 只动 status，其他字段与本来就没有该字段的记录原样保留
    expect(records).toEqual({
      a: { securityId: 'a', jobName: '前端' },
      b: { securityId: 'b' },
      c: { securityId: 'c' },
    })
  })

  it('账本里已经没有旧字段时不报告改动（迁移保持幂等）', () => {
    const records = { a: { securityId: 'a', match: null } } as unknown as Record<string, JobRecord>

    expect(stripRemovedRecordFields(records)).toBe(false)
  })
})
