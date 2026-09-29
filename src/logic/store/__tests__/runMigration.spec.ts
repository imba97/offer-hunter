import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planMigration, runMigration } from '~/logic/store/legacy'
import { readAllRecords } from '~/logic/store/records'
import { readRawSetting } from '~/logic/store/settings'
import { closeDb, get } from '~/platform/idb/database'
import { DB_NAME } from '~/platform/idb/schema'

/**
 * 真实迁移（`runMigration`）的五个场景。
 *
 * 这是整个改造里唯一会**动真实数据**的一段代码，所以每个场景都要钉住，
 * 尤其是「校验不过时旧数据必须原封不动」—— 那是用户唯一还拥有的东西。
 */

/** 旧存储的替身：可读写、可断言「键被删了没有」 */
const legacy = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  removals: [] as string[][],
}))

/** 让校验读到「和计划不一样」的结果，用来验证失败路径 */
const dbMock = vi.hoisted(() => ({ breakEntries: false }))

vi.mock('webextension-polyfill', () => ({
  storage: {
    local: {
      get: async (keys: string[]) => {
        const out: Record<string, unknown> = {}
        for (const key of keys) {
          if (Object.hasOwn(legacy.data, key))
            out[key] = legacy.data[key]
        }
        return out
      },
      remove: async (keys: string[]) => {
        legacy.removals.push(keys)
        for (const key of keys)
          delete legacy.data[key]
      },
    },
  },
  runtime: { id: 'test-extension-id', getManifest: () => ({ version: '1.1.0' }) },
}))

vi.mock('~/platform/idb/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/platform/idb/database')>()
  return {
    ...actual,
    getAllEntries: async (...args: Parameters<typeof actual.getAllEntries>) =>
      dbMock.breakEntries ? [] : actual.getAllEntries(...args),
  }
})

const AI_KEY = 'offer-hunter-ai'
const RESUME_KEY = 'offer-hunter-resume'
const RECORDS_KEY = 'offer-hunter-records'
const MATCHING_KEY = 'offer-hunter-matching'

/** 一份带历史包袱的存量数据（旧记录形状 + JSON 字符串简历） */
function legacyData(): Record<string, unknown> {
  return {
    [AI_KEY]: { platform: 'deepseek', baseUrl: '', apiKey: 'sk-secret-0123456789', model: '', threshold: 75 },
    [RESUME_KEY]: JSON.stringify({
      markdown: '# 我\n做过支付系统',
      gist: { token: 'ghp_token', gistId: 'aa5a315d61ae9438b18d', fileName: 'resume.md' },
      syncedFrom: 'aa5a315d61ae9438b18d|resume.md',
      syncedAt: '2026-03-01T00:00:00.000Z',
    }),
    [RECORDS_KEY]: {
      'boss:abc123def': {
        siteId: 'boss',
        naturalKey: 'abc123def',
        jobName: '高级前端工程师', // 旧接口字段名 → 应被映射成 title
        brandName: '某某科技',
        jdText: '岗位职责：…', // 当前模型不保存 → 应被丢弃
        encryptJobId: 'enc-1',
        match: { score: 82, summary: 's', reasons: ['r'], missingSkills: [] },
        greeting: '您好',
        error: null,
        firstSeen: '2026-01-11T00:00:00.000Z',
      },
      'eleduck:post-1': {
        siteId: 'eleduck',
        naturalKey: 'post-1',
        title: '远程前端',
        company: '',
        recruiterName: '',
        salary: '',
        match: null,
        greeting: null,
        error: '请求超时',
        firstSeen: '2026-02-01T00:00:00.000Z',
      },
    },
  }
}

/** 同一份数据、换成 `planMigration` 要的短 id 形状（它不认 chrome 键名） */
function legacyFixture(): Record<string, unknown> {
  const toShortId: Record<string, string> = {
    [AI_KEY]: 'ai',
    [RESUME_KEY]: 'resume',
    [MATCHING_KEY]: 'prompts',
    [RECORDS_KEY]: 'records',
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(legacyData()))
    out[toShortId[key] ?? key] = value
  return out
}

async function resetEverything(): Promise<void> {
  closeDb()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
  legacy.data = {}
  legacy.removals = []
  dbMock.breakEntries = false
}

beforeEach(resetEverything)
afterEach(closeDb)

describe('runMigration：全新安装', () => {
  it('四个旧键都没有内容时只落标记，不碰任何数据', async () => {
    const result = await runMigration()

    expect(result.status).toBe('fresh')
    const meta = await get<{ value: { fresh?: boolean } }>('meta', 'migration')
    expect(meta?.value.fresh).toBe(true)
    expect(await readAllRecords()).toEqual({})
    expect(legacy.removals).toEqual([])
  })

  it('再次调用会走「已迁移」而不是重复写标记', async () => {
    await runMigration()
    expect((await runMigration()).status).toBe('already-done')
  })
})

describe('runMigration：有存量数据', () => {
  it('把数据搬进 IndexedDB，校验通过后才删旧键', async () => {
    legacy.data = legacyData()

    const result = await runMigration()

    expect(result.status).toBe('migrated')
    expect(result.counts).toEqual({ records: 2 })

    // 设置：AI 少一个 threshold、多出默认字段；简历的 legacy gist 已搬进 sources
    const ai = await readRawSetting('ai') as Record<string, unknown>
    expect(ai.apiKey).toBe('sk-secret-0123456789')
    expect(ai).not.toHaveProperty('threshold')
    expect(ai.maxTokens).toBe(2048)

    const resume = await readRawSetting('resume') as Record<string, any>
    expect(resume.markdown).toBe('# 我\n做过支付系统')
    expect(resume.sources.gist.token).toBe('ghp_token')
    expect(resume.syncedKey).toBe('aa5a315d61ae9438b18d|resume.md')
    expect(resume).not.toHaveProperty('gist')

    // 账本：旧字段名被映射、模型外字段被丢弃（决策 F2）
    const records = await readAllRecords()
    expect(Object.keys(records).sort()).toEqual(['boss:abc123def', 'eleduck:post-1'])
    expect(records['boss:abc123def'].title).toBe('高级前端工程师')
    expect(records['boss:abc123def']).not.toHaveProperty('jdText')
    expect(records['boss:abc123def']).not.toHaveProperty('encryptJobId')

    // 标记里带着摘要，供日后排障对照
    const meta = await get<{ value: { counts: { records: number }, checksums: Record<string, string> } }>('meta', 'migration')
    expect(meta?.value.counts).toEqual({ records: 2 })
    expect(Object.keys(meta?.value.checksums ?? {}).length).toBeGreaterThan(0)

    // 只有校验通过之后才删旧键
    expect(legacy.removals).toHaveLength(1)
    expect(Object.keys(legacy.data)).toEqual([])
  })

  it('落库的摘要是按同一套算法算出来的（迁移前后自洽）', async () => {
    legacy.data = legacyData()

    // 用同一份快照先算一遍期望值：planMigration 是纯函数，不碰库
    const expected = planMigration({ values: legacyFixture() })
    await runMigration()

    const meta = await get<{ value: { checksums: Record<string, string>, counts: { records: number } } }>('meta', 'migration')
    expect(meta?.value.checksums).toEqual(expected.checksums)
    expect(meta?.value.counts).toEqual(expected.counts)
  })
})

describe('runMigration：校验不通过', () => {
  it('保留旧键、撤掉迁移标记，并报失败（否则下次会以为已迁完而跳过）', async () => {
    legacy.data = legacyData()
    dbMock.breakEntries = true // 让校验读到的记录数与计划不符

    const result = await runMigration()

    expect(result.status).toBe('failed')
    expect(result.error).toContain('校验未通过')

    // 旧数据是用户唯一还拥有的东西 —— 一条都不能少
    expect(Object.keys(legacy.data).sort()).toEqual([AI_KEY, RECORDS_KEY, RESUME_KEY].sort())
    expect(legacy.removals).toEqual([])

    // 标记必须撤掉，否则下次启动会跳过迁移
    expect(await get('meta', 'migration')).toBeUndefined()
  })

  it('修好之后重跑可以正常迁移（可重试）', async () => {
    legacy.data = legacyData()
    dbMock.breakEntries = true
    expect((await runMigration()).status).toBe('failed')

    dbMock.breakEntries = false
    const retry = await runMigration()

    expect(retry.status).toBe('migrated')
    expect(Object.keys(await readAllRecords())).toHaveLength(2)
    expect(Object.keys(legacy.data)).toEqual([])
  })
})

describe('runMigration：旧版本被装回来过', () => {
  it('按并集合并，冲突以 IndexedDB 为准，并记下合并时间', async () => {
    // 先正常迁一次
    legacy.data = legacyData()
    await runMigration()

    // 模拟：用户装回旧版本，旧版本又往 chrome.storage 写了一条新记录，并改了简历
    legacy.data = {
      [MATCHING_KEY]: { matchPrompt: '旧版本写的提示词', greetingPrompt: '' },
      [RECORDS_KEY]: {
        'boss:new-one': {
          siteId: 'boss',
          naturalKey: 'new-one',
          title: '旧版本新建的记录',
          company: '',
          recruiterName: '',
          salary: '',
          match: null,
          greeting: null,
          error: null,
          firstSeen: '2026-03-02T00:00:00.000Z',
        },
      },
    }

    const result = await runMigration()

    expect(result.status).toBe('merged')
    expect(result.counts).toEqual({ records: 1 }) // 只补了缺的那条

    const records = await readAllRecords()
    expect(Object.keys(records).sort()).toEqual(['boss:abc123def', 'boss:new-one', 'eleduck:post-1'])

    // 设置：IndexedDB 里已有的不被旧版本覆盖
    expect((await readRawSetting('ai') as Record<string, unknown>).apiKey).toBe('sk-secret-0123456789')
    expect((await readRawSetting('prompts') as Record<string, unknown>).matchPrompt).toBe('旧版本写的提示词')

    const meta = await get<{ value: { conflictMergedAt?: string } }>('meta', 'migration')
    expect(meta?.value.conflictMergedAt).toBeTruthy()

    // 合并完同样删掉旧键
    expect(Object.keys(legacy.data)).toEqual([])
  })
})
