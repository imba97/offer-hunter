import type { SettingDoc } from '~/logic/store/settings'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRawSetting, readSetting, writeSetting } from '~/logic/store/settings'
import { createDefaultAiSettings, createDefaultPromptSettings, createEmptyResume } from '~/logic/types'
import { closeDb, get, put, runTx } from '~/platform/idb/database'
import { DB_NAME } from '~/platform/idb/schema'

/**
 * `settings` 仓库的读写。
 *
 * 重点不是「存进去能读出来」，而是三件容易在改造中丢掉的事：
 *  1. **缺字段的旧文档要被补齐**（`mergeDefaults` 语义）—— 少了它，设置页读
 *     `apiKey.trim()` 会直接抛错；被 JSON 字符串化过的存量值也要能读。
 *  2. **`updatedAt` 由写入方统一盖**，不是调用方给的。
 *  3. **带 `ctx` 的写入真的并入了调用方事务** —— 用一个「后续请求失败导致整体回滚」
 *     的用例把它钉住：只断言「写进去了」是分不出「同一事务」与「各写各的」的。
 */

/** 每个用例都用干净的库：删库比清理数据更彻底，避免用例之间互相影响 */
async function resetDatabase(): Promise<void> {
  closeDb()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

beforeEach(resetDatabase)
afterEach(closeDb)

describe('读写文档', () => {
  it('写进去再读出来，原样往返', async () => {
    const value = { matchPrompt: '更看重高并发经验', greetingPrompt: '开头用「您好」' }

    await writeSetting('prompts', value)

    expect(await readRawSetting('prompts')).toEqual(value)
    expect(await readSetting('prompts', createDefaultPromptSettings())).toEqual(value)
  })

  it('文档不存在时读到 undefined，读设置则拿到 fallback', async () => {
    expect(await readRawSetting('ai')).toBeUndefined()
    expect(await readSetting('ai', createDefaultAiSettings())).toEqual(createDefaultAiSettings())
  })

  it('value 缺字段时补默认值（mergeDefaults 语义）', async () => {
    await writeSetting('ai', { platform: 'openai' })

    expect(await readSetting('ai', createDefaultAiSettings())).toEqual({
      platform: 'openai',
      baseUrl: '',
      apiKey: '',
      model: '',
      maxTokens: 2048,
    })
  })

  it('被 JSON 字符串化过的存量值照样读得出来（早期版本这么写过）', async () => {
    // 绕过 writeSetting 直接落库：writeSetting 的口径是「写什么就是什么」，
    // 而这里要模拟的是历史数据 —— 它的 value 是一个字符串
    await put<SettingDoc>('settings', {
      id: 'resume',
      value: JSON.stringify({ markdown: '# 张三', sourceId: 'gist' }),
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const resume = await readSetting('resume', createEmptyResume())
    expect(resume.markdown).toBe('# 张三')
    expect(resume.sourceId).toBe('gist')
    expect(resume.syncedKey).toBeNull() // 缺失字段被 fallback 补齐
  })

  it('写入时盖上 ISO 格式的 updatedAt', async () => {
    await writeSetting('ai', createDefaultAiSettings())

    const doc = await get<SettingDoc>('settings', 'ai')
    if (!doc)
      throw new Error('刚写完的文档必须读得回来')
    // 不是「像不像时间」，而是「就是 toISOString 的那个格式」（迁移与报告都按它比较）
    expect(new Date(doc.updatedAt).toISOString()).toBe(doc.updatedAt)
  })
})

describe('事务', () => {
  it('传入 ctx 时写入随事务一起提交', async () => {
    await runTx(['settings'], 'readwrite', async (ctx) => {
      await writeSetting('prompts', { matchPrompt: 'a', greetingPrompt: 'b' }, ctx)
      await writeSetting('resume', createEmptyResume(), ctx)
    })

    expect(await readRawSetting('prompts')).toEqual({ matchPrompt: 'a', greetingPrompt: 'b' })
    expect(await readRawSetting('resume')).toEqual(createEmptyResume())
  })

  it('传入 ctx 时写入属于调用方事务：事务回滚，写入一并作废', async () => {
    await writeSetting('ai', { platform: 'deepseek' })

    await expect(runTx(['settings'], 'readwrite', async (ctx) => {
      await writeSetting('ai', { platform: 'anthropic' }, ctx)
      // 绕过原语发一个必然失败的请求（add 一个已存在的键 → ConstraintError），
      // 让整个事务回滚 —— 上一行的写入若在自己开的事务里，就会留下来
      ctx.tx.objectStore('settings').add({ id: 'ai', value: {}, updatedAt: 'x' })
    })).rejects.toThrow()

    expect(await readRawSetting('ai')).toEqual({ platform: 'deepseek' })
  })
})
