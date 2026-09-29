import type { MigrationPlan, PreviewEnvironment } from '~/logic/store/legacy'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  digest64,
  planMigration,
  renderMigrationReport,
  stableJson,
} from '~/logic/store/legacy'

/**
 * 迁移干跑的单测。
 *
 * 重点有三个，都不是「跑通就行」那类：
 *  1. **归一管线与启动时一致** —— fixture 特意用了四种历史形状（对象 / JSON 字符串 /
 *     缺失键 / 非对象条目），断言它们各自被正确处理。
 *  2. **报告不泄露内容** —— 用哨兵字符串断言简历、API Key、token、岗位值都不出现。
 *     这条一旦失守，用户就会把自己的简历贴到聊天里。
 *  3. **摘要稳定** —— 键序不同的同一份数据必须得到同一个摘要，否则「迁移无损」
 *     的复核会误报。
 */

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getBytesInUse: vi.fn(),
}))

vi.mock('webextension-polyfill', () => ({
  storage: { local: { get: mocks.get, getBytesInUse: mocks.getBytesInUse } },
  runtime: { id: 'test-extension-id', getManifest: () => ({ version: '1.0.4' }) },
}))

// 哨兵：这些字符串**绝不能**出现在报告里
const RESUME_TEXT = '# 张三\n\n我在这家公司做前端开发，负责过支付系统。'
const API_KEY = 'sk-super-secret-key-0123456789'
const GIST_TOKEN = 'ghp_secretTokenValue0123456789'
const GIST_ID = 'aa5a315d61ae9438b18d'
const JOB_TITLE = '高级前端工程师'
const COMPANY = '某某科技有限公司'
const RECRUITER = '李女士'

const AI_KEY = 'offer-hunter-ai'
const RESUME_KEY = 'offer-hunter-resume'
const PROMPTS_KEY = 'offer-hunter-matching'
const RECORDS_KEY = 'offer-hunter-records'

/**
 * 一份尽量「脏」的存量快照（键用短 id，与 `LegacySnapshot` 的契约一致）：
 *  - ai：多一个已删除的 threshold（会被裁）、缺 maxTokens（会被补）
 *  - resume：JSON 字符串 + legacy `gist` / `syncedFrom`（要复活并改名）
 *  - prompts：整个键缺失（写默认值）
 *  - records：legacy 键（无 `:`）、legacy 字段（securityId / status）、一个非对象条目
 */
function legacyValues(): Record<string, unknown> {
  return {
    ai: {
      platform: 'deepseek',
      baseUrl: '',
      apiKey: API_KEY,
      model: '',
      threshold: 75,
    },
    resume: JSON.stringify({
      markdown: RESUME_TEXT,
      gist: { token: GIST_TOKEN, gistId: GIST_ID, fileName: 'resume.md' },
      syncedFrom: `${GIST_ID}|resume.md`,
      syncedAt: '2026-03-01T00:00:00.000Z',
    }),
    records: {
      'abc123def': {
        securityId: 'abc123def',
        title: JOB_TITLE,
        company: COMPANY,
        recruiterName: RECRUITER,
        salary: '30-50K·14薪',
        match: { score: 82, summary: '技术栈吻合', reasons: ['React 经验匹配'], missingSkills: ['K8s'] },
        greeting: '您好，我做过支付系统…',
        error: null,
        status: 'greeted',
        firstSeen: '2026-01-11T00:00:00.000Z',
      },
      'boss:modern': {
        siteId: 'boss',
        naturalKey: 'modern',
        title: '前端工程师',
        company: '另一家',
        recruiterName: '',
        salary: '',
        match: null,
        greeting: null,
        error: '请求超时',
        firstSeen: '2026-02-01T00:00:00.000Z',
      },
      'broken-entry': null,
    },
  }
}

/**
 * 把「短 id」形状换成 `storage.local.get` 的真实形状（chrome 完整键名）。
 *
 * 干跑内部用短 id 当快照的键（`LegacySnapshot` 的契约），而 storage 返回的是
 * 完整键名 —— 这一层映射正是 `previewMigration` 的职责之一，所以测试要按真实
 * 形状喂它，否则测的是自己编的形状。
 */
function asStorageShape(values: Record<string, unknown>): Record<string, unknown> {
  const map: Record<string, string> = {
    ai: AI_KEY,
    resume: RESUME_KEY,
    prompts: PROMPTS_KEY,
    records: RECORDS_KEY,
  }
  return Object.fromEntries(Object.entries(values).map(([id, value]) => [map[id] ?? id, value]))
}

const ENV: PreviewEnvironment = {
  at: '2026-09-29T10:00:00.000Z',
  version: '1.0.4',
  where: 'sidepanel',
  extensionId: 'test-extension-id',
  idbDatabases: [],
  estimate: { usage: 1234, quota: 60000000000 },
}

function plan(overrides: { values?: Record<string, unknown>, bytes?: Record<string, number> } = {}): MigrationPlan {
  return planMigration({
    values: overrides.values ?? legacyValues(),
    bytes: overrides.bytes ?? { ai: 212, resume: 3100, records: 812000 },
  })
}

describe('planMigration：四种历史形状都处理对', () => {
  it('把 JSON 字符串的简历复活，并把 legacy gist / syncedFrom 改名搬进 sources', () => {
    const resume = plan().settings.find(s => s.id === 'resume')!.value as Record<string, any>

    expect(resume.markdown).toBe(RESUME_TEXT)
    expect(resume.sources.gist).toMatchObject({
      token: GIST_TOKEN,
      gistId: GIST_ID,
      fileName: 'resume.md',
    })
    // syncedFrom → syncedKey
    expect(resume.syncedKey).toBe(`${GIST_ID}|resume.md`)
    // legacy 字段不能留在对象里
    expect(resume).not.toHaveProperty('gist')
    expect(resume).not.toHaveProperty('syncedFrom')
    // 每个已注册来源都要有完整形状
    expect(Object.keys(resume.sources).sort()).toEqual(['gist', 'paste'])
  })

  it('ai：裁掉已删除字段、补上缺失字段', () => {
    const ai = plan().settings.find(s => s.id === 'ai')!

    expect(ai.value).toMatchObject({ platform: 'deepseek', apiKey: API_KEY })
    expect(ai.value).not.toHaveProperty('threshold')
    expect((ai.value as Record<string, unknown>).maxTokens).toBe(2048)
    expect(ai.notes.join('；')).toContain('threshold')
    expect(ai.notes.join('；')).toContain('maxTokens')
  })

  it('prompts：键缺失时写默认值并说明', () => {
    const prompts = plan().settings.find(s => s.id === 'prompts')!

    expect(prompts.value).toMatchObject({ matchPrompt: '', greetingPrompt: '' })
    expect(prompts.notes.join('；')).toContain('键不存在')
  })

  it('records：统计只报结构，不报内容；归一后键与字段都迁好', () => {
    const result = plan()
    const stats = result.recordStats

    expect(stats.total).toBe(3)
    expect(stats.nonObject).toBe(1) // broken-entry
    expect(stats.needsKeyMigration).toBe(1) // abc123def
    expect(stats.hasSecurityId).toBe(1)
    expect(stats.hasStatus).toBe(1)
    expect(stats.withMatch).toBe(1)
    expect(stats.withGreeting).toBe(1)
    expect(stats.withError).toBe(1)
    expect(stats.bySiteId).toEqual({ '(无)': 1, 'boss': 1 })
    expect(stats.firstSeen).toEqual({
      min: '2026-01-11T00:00:00.000Z',
      max: '2026-02-01T00:00:00.000Z',
    })
    // 字段直方图只给名字与计数（值一律不进报告）
    expect(stats.fieldCounts.title).toBe(2) // 两条记录都有
    expect(stats.fieldCounts.securityId).toBe(1) // 只有 legacy 那条有
    expect(stats.fieldCounts.firstSeen).toBe(2)

    // 归一结果：非对象条目被丢弃，legacy 键改成 站点:标识，legacy 字段抹掉
    expect(Object.keys(result.records).sort()).toEqual(['boss:abc123def', 'boss:modern'])
    expect(result.counts.records).toBe(2)
    const migrated = result.records['boss:abc123def'] as unknown as Record<string, unknown>
    expect(migrated.siteId).toBe('boss')
    expect(migrated.naturalKey).toBe('abc123def')
    expect(migrated).not.toHaveProperty('securityId')
    expect(migrated).not.toHaveProperty('status')
  })

  it('记录形状：能认出「重构前的接口原名」那一整批记录', () => {
    /*
     * 这份 fixture 抄自真机干跑报告：整本账本仍是重构前的形状
     * （jobName / brandName / salaryDesc / jdText / encryptJobId / haveChatted…）。
     * 只看首条记录的字段名是看不出这件事的 —— 这正是把直方图做出来的原因。
     */
    const legacyWireRecord = {
      jobName: '高级前端工程师',
      brandName: '某某科技',
      bossName: '李女士',
      bossTitle: 'HR',
      bossOnline: true,
      salaryDesc: '30-50K',
      jdText: '岗位职责：…',
      jobDegree: '本科',
      jobExperience: '3-5 年',
      skills: ['React'],
      cityName: '北京',
      encryptJobId: 'enc-job',
      encryptBossId: 'enc-boss',
      haveChatted: true,
      isFriend: false,
      lastAction: 'greeted',
      lastTouchedDate: 1234567890,
      match: { score: 80, summary: 's', reasons: [], missingSkills: [] },
      greeting: '您好',
      error: null,
      firstSeen: '2026-01-11T00:00:00.000Z',
    }

    const result = planMigration({
      values: {
        records: {
          'boss:legacy-one': legacyWireRecord,
          'boss:new-one': {
            siteId: 'boss',
            naturalKey: 'new-one',
            title: '前端',
            company: 'C',
            recruiterName: '',
            salary: '',
            match: null,
            greeting: null,
            error: null,
            firstSeen: '2026-02-01T00:00:00.000Z',
          },
        },
      },
    })
    const stats = result.recordStats

    expect(stats.legacyWireShape).toBe(1)
    expect(stats.newShape).toBe(1)
    expect(stats.mixedShape).toBe(0)
    expect(stats.withJdText).toBe(1)
    expect(stats.withSiteIds).toBe(1)
    expect(stats.withUnknownFields).toBe(1)
    expect(stats.brokenMatches).toBe(0)

    // 未知字段要被点名，否则迁移时不知道该不该留
    for (const field of ['jobName', 'brandName', 'salaryDesc', 'jdText', 'encryptJobId', 'haveChatted', 'lastAction']) {
      expect(stats.unknownFields).toContain(field)
    }
    expect(stats.unknownFields).not.toContain('title')
    expect(stats.unknownFields).not.toContain('match')

    // F2：归一后只剩当前模型的字段，接口原名被映射过来、其余一律丢掉
    const normalized = result.records['boss:legacy-one'] as unknown as Record<string, unknown>
    expect(normalized).toEqual({
      siteId: 'boss',
      naturalKey: 'legacy-one',
      title: '高级前端工程师',
      company: '某某科技',
      recruiterName: '李女士',
      salary: '30-50K',
      match: { score: 80, summary: 's', reasons: [], missingSkills: [] },
      greeting: '您好',
      error: null,
      firstSeen: '2026-01-11T00:00:00.000Z',
    })
    expect(normalized).not.toHaveProperty('jdText')
    expect(normalized).not.toHaveProperty('encryptJobId')

    // 报告里要把形状分布写出来，供人拍板「留还是归一」
    const report = renderMigrationReport(result, ENV)
    expect(report).toContain('含旧接口字段名 1')
    expect(report).toContain('含 jdText 1')
    expect(report).toContain('含未知字段的记录 1 条')
    expect(report).toContain('未知字段（当前模型不认识）')
    // JD 原文属记录内容，仍然不得出现
    expect(report).not.toContain('岗位职责：…')
  })

  it('旧键概览：区分「存在但类型是字符串」与「不存在」', () => {
    const kinds = Object.fromEntries(plan().legacyKeys.map(k => [k.id, [k.present, k.kind]]))

    expect(kinds.ai).toEqual([true, 'object'])
    expect(kinds.resume).toEqual([true, '字符串(JSON)'])
    expect(kinds.prompts).toEqual([false, '缺失'])
    expect(kinds.records).toEqual([true, 'object'])
  })

  it('全新安装：四个键都缺失时也能产出计划', () => {
    const result = plan({ values: {}, bytes: {} })

    expect(result.legacyKeys.every(k => !k.present)).toBe(true)
    expect(result.counts.records).toBe(0)
    expect(result.recordStats.total).toBe(0)
    expect(renderMigrationReport(result, ENV)).toContain('四个旧键全都不存在')
  })
})

describe('报告脱敏', () => {
  it('简历、API Key、token、Gist ID、岗位值都不出现在报告里', () => {
    const report = renderMigrationReport(plan(), ENV)

    for (const secret of [RESUME_TEXT, API_KEY, GIST_TOKEN, GIST_ID, JOB_TITLE, COMPANY, RECRUITER]) {
      expect(report).not.toContain(secret)
    }
  })

  it('提示词要单独成节，且只给长度与摘要', () => {
    const PROMPT = '更看重高并发经验，有开源贡献加分'
    const result = planMigration({
      values: { ...legacyValues(), prompts: { matchPrompt: PROMPT, greetingPrompt: '' } },
    })
    const report = renderMigrationReport(result, ENV)

    expect(report).toContain('[prompts]')
    expect(report).toContain(digest64(PROMPT))
    expect(report).not.toContain(PROMPT)
    // 空的那一段仍要出现，否则看报告的人不知道是「空」还是「没检查」
    expect(report).toContain('greetingPrompt (空)')
  })

  it('但报告要给出足以核对的长度与摘要', () => {
    const report = renderMigrationReport(plan(), ENV)

    expect(report).toContain(`长度 ${RESUME_TEXT.length}`)
    expect(report).toContain(digest64(RESUME_TEXT))
    expect(report).toContain(digest64(API_KEY))
    // 简历原文的行数可以给：它是结构信息，不是内容
    expect(report).toContain(`行数 ${RESUME_TEXT.split('\n').length}`)
  })

  it('明确声明自己没有写入任何东西', () => {
    const report = renderMigrationReport(plan(), ENV)

    expect(report).toContain('只读')
    expect(report).toContain('未写入任何数据')
  })
})

describe('摘要稳定性', () => {
  it('键序不同的同一份数据，摘要相同', () => {
    const ordered = { 'boss:x': { siteId: 'boss', naturalKey: 'x', title: 'T' } }
    const shuffled = { 'boss:x': { title: 'T', naturalKey: 'x', siteId: 'boss' } }

    const a = planMigration({ values: { records: ordered } })
    const b = planMigration({ values: { records: shuffled } })

    expect(a.counts.records).toBe(1) // 非空，否则下面的断言是空转
    expect(a.checksums['records.digest']).toBe(b.checksums['records.digest'])
    expect(stableJson(ordered['boss:x'])).toBe(stableJson(shuffled['boss:x']))
  })

  it('内容变了摘要必须变（否则校验没有意义）', () => {
    const before = planMigration({ values: { resume: { markdown: 'A' } } })
    const after = planMigration({ values: { resume: { markdown: 'B' } } })

    expect(before.checksums['resume.markdown']).toBeDefined()
    expect(before.checksums['resume.markdown']).not.toBe(after.checksums['resume.markdown'])
  })

  it('空值不进摘要表（避免把「本来就没有」当成待核对项）', () => {
    const result = planMigration({ values: { ai: { platform: 'deepseek', apiKey: '' } } })

    expect(result.checksums).not.toHaveProperty('ai.apiKey')
  })
})

describe('previewMigration：只读取数', () => {
  beforeEach(() => {
    mocks.get.mockReset()
    mocks.getBytesInUse.mockReset()
  })

  it('读出旧键并产出报告，且只调 get / getBytesInUse', async () => {
    mocks.get.mockResolvedValue(asStorageShape(legacyValues()))
    mocks.getBytesInUse.mockResolvedValue(1024)

    const { previewMigration } = await import('~/logic/store/legacy')
    const { plan: result, report } = await previewMigration()

    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(result.legacyKeys.filter(k => k.present)).toHaveLength(3)
    expect(result.counts.records).toBe(2)
    expect(report).toContain('test-extension-id')
    expect(report).toContain('1.0.4')
    // fake-indexeddb 提供 databases()，所以这里能真的列出已有库（浏览器里同款）
    expect(report).toContain('IndexedDB 已有库 [')
    // 只读：mock 里根本不存在任何写入方法，若代码试图写入会直接抛错
    expect(mocks.getBytesInUse).toHaveBeenCalledWith(RESUME_KEY)
  })

  it('getBytesInUse 抛错时不影响报告生成', async () => {
    mocks.get.mockResolvedValue(asStorageShape(legacyValues()))
    mocks.getBytesInUse.mockRejectedValue(new Error('not supported'))

    const { previewMigration } = await import('~/logic/store/legacy')
    const { report } = await previewMigration()

    expect(report).toContain('[旧键概览]')
    expect(report).toContain('未知')
  })
})
