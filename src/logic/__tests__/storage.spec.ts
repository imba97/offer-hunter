import type { JobRecord } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { mergeDefaults, stripRemovedRecordFields } from '../storage'
import {
  createDefaultAiSettings,
  createDefaultPromptSettings,
  createEmptyGistSource,
  createEmptyResume,
  normalizeResumeSource,
} from '../types'

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
    // 这条数据是「简历还只有 markdown / sourceId / updatedAt」那个版本的形状
    const merged = mergeDefaults(
      { markdown: '# 我', sourceId: null, updatedAt: null, basics: { city: '上海' } },
      createEmptyResume(),
    )

    // 新增的 Gist 配置要被补成默认值，而不是留成 undefined
    expect(merged).toEqual({ ...createEmptyResume(), markdown: '# 我' })
    expect(merged.gist).toEqual(createEmptyGistSource())
    expect('basics' in merged).toBe(false)
  })

  it('简历里已有的 Gist 配置不被默认值覆盖（token 是可选字段，留着）', () => {
    const merged = mergeDefaults(
      {
        markdown: '# 我',
        gist: { token: 'ghp_x', gistId: 'aa5a315d61ae9438b18d', fileName: 'resume.md' },
      },
      createEmptyResume(),
    )

    expect(merged.gist).toEqual({
      token: 'ghp_x',
      gistId: 'aa5a315d61ae9438b18d',
      fileName: 'resume.md',
    })
  })

  it('把早期被 JSON 字符串化的数据还原成对象，并补上新增的提示词字段', () => {
    // 这条数据是「提示词只有招呼语那一段」那个版本的形状（存储键当时叫 matching）
    const legacy = JSON.stringify({ greetingPrompt: '开头用您好' })
    const merged = mergeDefaults(legacy, createDefaultPromptSettings())

    // 写过的招呼语不许丢，新加的匹配度分析提示词补成空串
    expect(merged).toEqual({ matchPrompt: '', greetingPrompt: '开头用您好' })
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

/**
 * 简历来源的收敛。
 *
 * 存储里出现 null 或已废弃的值都不该让界面处于「两个选项都没选中」的状态，
 * 它们原本的行为就是手动输入。
 */
describe('normalizeResumeSource', () => {
  it('保留 gist', () => {
    expect(normalizeResumeSource('gist')).toBe('gist')
  })

  it('paste / null / 已废弃的 pdf / 乱七八糟的值都按手动输入处理', () => {
    expect(normalizeResumeSource('paste')).toBe('paste')
    expect(normalizeResumeSource(null)).toBe('paste')
    expect(normalizeResumeSource('pdf')).toBe('paste')
    expect(normalizeResumeSource(undefined)).toBe('paste')
  })
})
