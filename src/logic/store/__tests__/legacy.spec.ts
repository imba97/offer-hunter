import type { MigrationPlan } from '~/logic/store/legacy'
import { describe, expect, it, vi } from 'vitest'
import { computeChecksums, digest64, planMigration, stableJson } from '~/logic/store/legacy'

/**
 * 迁移计划与摘要（`planMigration` / `computeChecksums`）。
 *
 * 这两个是**真实迁移的一部分**（`runMigration` 产出计划、`verifyMigration` 用同一套
 * 摘要对账），所以断言必须落在「迁移写进库的形状」上。
 *
 * 历史提醒：这里曾经还有一整块「干跑报告」的测试（渲染、脱敏、预览取数）。
 * 那个临时 tab 删掉后，报告那一半已从 legacy.ts 移除，相关测试也随之删除 ——
 * 但**它当初抓到的两件事仍然由本文件钉住**：
 *   1. 「记录形状」是整本账本的属性，不能只看首条；
 *   2. 旧字段名必须被映射、模型外字段必须被丢弃（决策 F2）。
 */

vi.mock('webextension-polyfill', () => ({
  storage: { local: { get: vi.fn(), remove: vi.fn() } },
}))

const RESUME_TEXT = '# 张三\n\n我在这家公司做前端开发，负责过支付系统。'
const API_KEY = 'sk-super-secret-key-0123456789'
const GIST_TOKEN = 'ghp_secretTokenValue0123456789'
const GIST_ID = 'aa5a315d61ae9438b18d'
const JOB_TITLE = '高级前端工程师'

/** 一份尽量「脏」的存量快照（键用短 id，与 `LegacySnapshot` 的契约一致） */
function legacyValues(): Record<string, unknown> {
  return {
    ai: { platform: 'deepseek', baseUrl: '', apiKey: API_KEY, model: '', threshold: 75 },
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
        company: '某某科技有限公司',
        recruiterName: '李女士',
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

function plan(values: Record<string, unknown> = legacyValues()): MigrationPlan {
  return planMigration({ values })
}

function settingOf(result: MigrationPlan, id: 'ai' | 'resume' | 'prompts'): Record<string, any> {
  const found = result.settings.find(setting => setting.id === id)
  if (!found)
    throw new Error(`计划里缺少 ${id}`)
  return found.value as Record<string, any>
}

describe('planMigration：四种历史形状都处理对', () => {
  it('把 JSON 字符串的简历复活，并把 legacy gist / syncedFrom 改名搬进 sources', () => {
    const resume = settingOf(plan(), 'resume')

    expect(resume.markdown).toBe(RESUME_TEXT)
    expect(resume.sources.gist).toMatchObject({
      token: GIST_TOKEN,
      gistId: GIST_ID,
      fileName: 'resume.md',
    })
    expect(resume.syncedKey).toBe(`${GIST_ID}|resume.md`)
    expect(resume).not.toHaveProperty('gist')
    expect(resume).not.toHaveProperty('syncedFrom')
    expect(Object.keys(resume.sources).sort()).toEqual(['gist', 'paste'])
  })

  it('ai：裁掉已删除字段、补上缺失字段', () => {
    const ai = settingOf(plan(), 'ai')

    expect(ai).toMatchObject({ platform: 'deepseek', apiKey: API_KEY, maxTokens: 2048 })
    expect(ai).not.toHaveProperty('threshold')
  })

  it('prompts：键缺失时写默认值', () => {
    expect(settingOf(plan(), 'prompts')).toMatchObject({ matchPrompt: '', greetingPrompt: '' })
  })

  it('records：非对象条目被丢弃、legacy 键改名、legacy 字段抹掉', () => {
    const result = plan()

    expect(Object.keys(result.records).sort()).toEqual(['boss:abc123def', 'boss:modern'])
    expect(result.counts.records).toBe(2)

    const migrated = result.records['boss:abc123def'] as unknown as Record<string, unknown>
    expect(migrated).toMatchObject({ siteId: 'boss', naturalKey: 'abc123def', title: JOB_TITLE })
    expect(migrated).not.toHaveProperty('securityId')
    expect(migrated).not.toHaveProperty('status')
  })

  it('记录形状：重构前的接口原名整批映射、模型外字段整批丢弃（决策 F2）', () => {
    /*
     * 这份 fixture 抄自真机干跑：当时整本账本仍是重构前的形状
     * （jobName / brandName / salaryDesc / jdText / encryptJobId / haveChatted…）。
     * 单独成用例是因为「形状」是整本账本的属性 —— 只看首条会得出错误印象。
     */
    const result = plan({
      records: {
        'boss:legacy-one': {
          siteId: 'boss',
          naturalKey: 'legacy-one',
          jobName: '资深后端工程师',
          brandName: '某某科技',
          bossName: '王先生',
          salaryDesc: '40-60K',
          jdText: '岗位职责：…',
          encryptJobId: 'enc-job',
          haveChatted: true,
          lastAction: 'greeted',
          match: { score: 80, summary: 's', reasons: [], missingSkills: [] },
          greeting: '您好',
          error: null,
          firstSeen: '2026-01-11T00:00:00.000Z',
        },
      },
    })

    expect(result.records['boss:legacy-one']).toEqual({
      siteId: 'boss',
      naturalKey: 'legacy-one',
      title: '资深后端工程师',
      company: '某某科技',
      recruiterName: '王先生',
      salary: '40-60K',
      match: { score: 80, summary: 's', reasons: [], missingSkills: [] },
      greeting: '您好',
      error: null,
      firstSeen: '2026-01-11T00:00:00.000Z',
    })
  })

  it('全新安装：四个键都缺失时也能产出计划', () => {
    const result = plan({})

    expect(result.counts.records).toBe(0)
    expect(result.records).toEqual({})
    expect(result.settings).toHaveLength(3)
  })
})

describe('computeChecksums', () => {
  it('只给非空字段记摘要（「本来就没有」不该成为待核对项）', () => {
    const result = plan({ ai: { platform: 'deepseek', apiKey: '' }, records: {} })

    expect(result.checksums).not.toHaveProperty('ai.apiKey')
    expect(result.checksums).toHaveProperty('records.digest')
  })

  it('简历与密钥都进了摘要表，且摘要本身不含原文', () => {
    const checksums = plan().checksums

    expect(checksums['resume.markdown']).toBe(digest64(RESUME_TEXT))
    expect(checksums['ai.apiKey']).toBe(digest64(API_KEY))
    expect(checksums['resume.sources.gist.token']).toBe(digest64(GIST_TOKEN))
    for (const digest of Object.values(checksums))
      expect(digest).toMatch(/^[0-9a-f]{16}$/)
  })

  it('键序不同的同一份数据摘要相同（否则迁移后的复核会误报）', () => {
    const ordered = { 'boss:x': { siteId: 'boss', naturalKey: 'x', title: 'T' } }
    const shuffled = { 'boss:x': { title: 'T', naturalKey: 'x', siteId: 'boss' } }

    const a = planMigration({ values: { records: ordered } })
    const b = planMigration({ values: { records: shuffled } })

    expect(a.counts.records).toBe(1)
    expect(a.checksums['records.digest']).toBe(b.checksums['records.digest'])
    expect(stableJson(ordered['boss:x'])).toBe(stableJson(shuffled['boss:x']))
  })

  it('内容变了摘要必须变（否则校验没有意义）', () => {
    const before = computeChecksums({
      ai: { platform: 'deepseek', baseUrl: '', apiKey: 'a', model: '', maxTokens: 1 },
      resume: { markdown: 'A', sourceId: null, sources: {}, syncedAt: null, syncedKey: null, updatedAt: null },
      prompts: { matchPrompt: '', greetingPrompt: '' },
      records: [],
    })
    const after = computeChecksums({
      ai: { platform: 'deepseek', baseUrl: '', apiKey: 'b', model: '', maxTokens: 1 },
      resume: { markdown: 'A', sourceId: null, sources: {}, syncedAt: null, syncedKey: null, updatedAt: null },
      prompts: { matchPrompt: '', greetingPrompt: '' },
      records: [],
    })

    expect(before['ai.apiKey']).not.toBe(after['ai.apiKey'])
    expect(before['resume.markdown']).toBe(after['resume.markdown'])
  })
})
