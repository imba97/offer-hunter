import type { JobRecord } from '../types'
import { describe, expect, it } from 'vitest'
import { normalizeResumeSource } from '../resume-sources/registry'
import {
  ensureSourceConfigs,
  mergeDefaults,
  migrateRecordKeys,
  migrateResumeShape,
  normalizeRecordShape,
} from '../store/migrations'
import {
  createDefaultAiSettings,
  createDefaultPromptSettings,
  createEmptyResume,
  recordKey,
} from '../types'

/**
 * 存储迁移（纯函数）的单测。
 *
 * 这些函数住在 `logic/store/migrations.ts`：它们被「日常读写」与「一次性迁移」
 * 共用，而后者又被前者间接引用 —— 留在大文件里会形成循环依赖。
 * 本文件只测纯函数，因此**不需要**任何存储 API 的替身。
 */

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
    const records = { 'boss:a': { naturalKey: 'a' }, 'boss:b': { naturalKey: 'b' } }
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
 * 记录形状的归一化：**按当前模型白名单重建**。
 *
 * 存在的理由：`mergeDefaults` 对账本这个动态键映射不做裁剪，于是历史字段
 * （接口原名、jdText、站点私有 id、早已无人消费的状态字段）会永远跟着存量数据。
 * 真机上实测有 23 个这样的字段名，所以只能白名单式重建，不能逐个删。
 */
describe('normalizeRecordShape', () => {
  it('把接口原名映射到当前字段名，并丢掉模型外的字段', () => {
    const records = {
      'boss:a': {
        siteId: 'boss',
        naturalKey: 'a',
        jobName: '前端工程师',
        brandName: '某某科技',
        bossName: '李女士',
        salaryDesc: '30-50K',
        jdText: '岗位职责：…',
        encryptJobId: 'enc-1',
        haveChatted: true,
        lastAction: 'greeted',
        status: 'skipped',
        match: { score: 80, summary: 's', reasons: ['r'], missingSkills: [] },
        greeting: '您好',
        error: null,
        firstSeen: '2026-01-01T00:00:00.000Z',
      },
    } as unknown as Record<string, JobRecord>

    expect(normalizeRecordShape(records)).toBe(true)
    expect(records['boss:a']).toEqual({
      siteId: 'boss',
      naturalKey: 'a',
      title: '前端工程师',
      company: '某某科技',
      recruiterName: '李女士',
      salary: '30-50K',
      match: { score: 80, summary: 's', reasons: ['r'], missingSkills: [] },
      greeting: '您好',
      error: null,
      firstSeen: '2026-01-01T00:00:00.000Z',
    })
  })

  it('当前字段名优先于接口原名（两种都有时不被旧值覆盖）', () => {
    const records = {
      'boss:a': { siteId: 'boss', naturalKey: 'a', title: '新标题', jobName: '旧标题', firstSeen: 'x' },
    } as unknown as Record<string, JobRecord>

    normalizeRecordShape(records)
    expect((records['boss:a'] as unknown as Record<string, unknown>).title).toBe('新标题')
  })

  it('身份字段缺失时从账本键回填（不留空身份的记录）', () => {
    const records = { 'boss:abc123': { title: '前端' } } as unknown as Record<string, JobRecord>

    normalizeRecordShape(records)
    expect(records['boss:abc123']).toMatchObject({ siteId: 'boss', naturalKey: 'abc123' })
  })

  it('补全缺失字段，且已经合规的记录不报告改动（幂等）', () => {
    const compliant = {
      'boss:a': {
        siteId: 'boss',
        naturalKey: 'a',
        title: '前端',
        company: '',
        recruiterName: '',
        salary: '',
        match: null,
        greeting: null,
        error: null,
        firstSeen: '2026-01-01T00:00:00.000Z',
      },
    } as unknown as Record<string, JobRecord>

    expect(normalizeRecordShape(compliant)).toBe(false)

    const incomplete = { 'boss:b': { siteId: 'boss', naturalKey: 'b' } } as unknown as Record<string, JobRecord>
    expect(normalizeRecordShape(incomplete)).toBe(true)
    expect(incomplete['boss:b']).toMatchObject({ title: '', greeting: null, error: null, match: null })
  })

  it('match 缺数组时补成空数组（面板会 .join，缺了会崩），完好时连引用都不换', () => {
    const intact = { score: 80, summary: 's', reasons: ['r'], missingSkills: ['m'] }
    const records = {
      'boss:broken': { siteId: 'boss', naturalKey: 'broken', match: { score: 70, summary: 's' }, firstSeen: 'x' },
      'boss:ok': { siteId: 'boss', naturalKey: 'ok', match: intact, firstSeen: 'x' },
    } as unknown as Record<string, JobRecord>

    normalizeRecordShape(records)

    expect(records['boss:broken'].match).toEqual({ score: 70, summary: 's', reasons: [], missingSkills: [] })
    expect(records['boss:ok'].match).toBe(intact)
  })
})

/**
 * 账本键的站点命名空间迁移。
 *
 * 加第二个站点之前，键只是 securityId。没有命名空间时两家的标识撞车会把 A 站的
 * 分析结果显示到 B 站的岗位上（缓存命中错的记录）。存量数据一律属于 BOSS ——
 * 那个年代扩展只支持 BOSS 一家，迁移因此是确定的。
 */
describe('migrateRecordKeys', () => {
  it('把裸 securityId 键迁成 boss:<id>，字段一并改名', () => {
    const records = {
      abc123: { securityId: 'abc123', title: '前端', match: null },
    } as unknown as Record<string, JobRecord>

    expect(migrateRecordKeys(records)).toBe(true)
    expect(records).toEqual({
      'boss:abc123': { siteId: 'boss', naturalKey: 'abc123', title: '前端', match: null },
    })
    // securityId 是 BOSS 的字段名，不该继续留在记录里
    expect('securityId' in records['boss:abc123']).toBe(false)
  })

  it('已经带命名空间的记录原样保留（迁移幂等）', () => {
    const records = {
      'eleduck:z1fRK7': { siteId: 'eleduck', naturalKey: 'z1fRK7', title: '寻投手' },
    } as unknown as Record<string, JobRecord>

    expect(migrateRecordKeys(records)).toBe(false)
    expect(records).toEqual({
      'eleduck:z1fRK7': { siteId: 'eleduck', naturalKey: 'z1fRK7', title: '寻投手' },
    })
  })

  it('键里没有、字段里也没有标识时退回用键当标识（不丢数据）', () => {
    const records = { abc123: { title: '前端' } } as unknown as Record<string, JobRecord>

    expect(migrateRecordKeys(records)).toBe(true)
    expect(records[recordKey({ siteId: 'boss', naturalKey: 'abc123' })].title).toBe('前端')
  })

  it('账本为空时不动，也不报告改动', () => {
    expect(migrateRecordKeys({})).toBe(false)
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
