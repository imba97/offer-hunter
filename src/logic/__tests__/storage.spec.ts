import type { JobRecord } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { normalizeResumeSource } from '../resume-sources/registry'
import {
  ensureSourceConfigs,
  mergeDefaults,
  migrateResumeShape,
  stripRemovedRecordFields,
} from '../storage'
import {
  createDefaultAiSettings,
  createDefaultPromptSettings,
  createEmptyResume,
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

    expect(merged).toEqual({ ...createEmptyResume(), markdown: '# 我' })
    expect('basics' in merged).toBe(false)
  })

  it('嵌套对象逐层合并（来源配置是按 id 分组的映射）', () => {
    const merged = mergeDefaults(
      { sources: { gist: { gistId: 'aa5a315d61ae9438b18d' } } },
      createEmptyResume(),
    )

    expect(merged.sources.gist).toEqual({ gistId: 'aa5a315d61ae9438b18d' })
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
 * 它们原本的行为就是手动输入。判断依据现在来自注册表而不是写死的三元表达式，
 * 因此新增来源会自动被认。
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

/**
 * 每个已注册来源都必须有一份完整形状的配置。
 *
 * 设置页的字段是 v-model 直接绑到 `sources[id][field]` 上的，缺键就会在渲染期
 * 抛 "Cannot read properties of undefined"。所以「加来源不用写迁移」这条承诺
 * 全靠这个函数。
 */
describe('ensureSourceConfigs', () => {
  it('给没有配置的来源补出默认形状', () => {
    const sources = ensureSourceConfigs(undefined)

    expect(sources.gist).toEqual({ token: '', gistId: '', fileName: '' })
    expect(sources.paste).toEqual({})
  })

  it('已有的字段值不被默认值覆盖', () => {
    const sources = ensureSourceConfigs({
      gist: { gistId: 'aa5a315d61ae9438b18d', token: 'ghp_x' },
    })

    expect(sources.gist).toEqual({
      gistId: 'aa5a315d61ae9438b18d',
      token: 'ghp_x',
      // createConfig 声明过、但用户没填的键补成空串
      fileName: '',
    })
  })
})

/**
 * 「简历来源还是硬编码的 gist 字段」那个版本的迁移。
 *
 * 这两处都是**搬家/改名**：`gist` → `sources.gist`、`syncedFrom` → `syncedKey`。
 * 丢了的后果分别是「用户手填的 Gist 配置没了」和「刚同步过却每次打开设置页都重取」
 * —— 都不报错，所以必须有测试钉住。
 */
describe('migrateResumeShape', () => {
  it('把顶层 gist 搬进 sources.gist，并补出其它来源的配置', () => {
    const { value, changed } = migrateResumeShape({
      markdown: '# 我',
      sourceId: 'gist',
      gist: { token: 'ghp_x', gistId: 'aa5a315d61ae9438b18d', fileName: 'resume.md' },
      syncedFrom: 'aa5a315d61ae9438b18d|resume.md',
    })

    expect(changed).toBe(true)
    const next = value as Record<string, any>
    expect(next.gist).toBeUndefined()
    expect(next.sources.gist).toEqual({
      gistId: 'aa5a315d61ae9438b18d',
      fileName: 'resume.md',
      token: 'ghp_x',
    })
    expect(next.sources.paste).toEqual({})
    // 内容标识改名但值不变 —— 换了名字就丢掉会让节流判断失效
    expect(next.syncedFrom).toBeUndefined()
    expect(next.syncedKey).toBe('aa5a315d61ae9438b18d|resume.md')
    expect(next.markdown).toBe('# 我')
  })

  it('已经是新形状时原样返回并报告无改动（迁移幂等）', () => {
    const current = {
      markdown: '# 我',
      sourceId: 'gist',
      sources: { gist: { token: '', gistId: 'aa5a315d61ae9438b18d', fileName: '' } },
      syncedKey: 'aa5a315d61ae9438b18d|',
      syncedAt: '2026-03-01T00:00:00.000Z',
      updatedAt: null,
    }

    const { value, changed } = migrateResumeShape(current)

    // 同一个引用：调用方据此跳过写入，不必靠 JSON 比较
    expect(changed).toBe(false)
    expect(value).toBe(current)
  })

  it('非对象（含 undefined）不炸', () => {
    expect(migrateResumeShape(undefined).changed).toBe(false)
    expect(migrateResumeShape('一段文本').changed).toBe(false)
    expect(migrateResumeShape(null).changed).toBe(false)
  })
})
