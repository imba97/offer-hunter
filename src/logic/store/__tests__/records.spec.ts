import type { JobRecord } from '~/logic/types'
import type { Entry } from '~/platform/idb/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRecords, countRecords, MAX_RECORDS, readAllRecords, readRecord, upsertRecord } from '~/logic/store/records'
import { recordKey } from '~/logic/types'
import { closeDb, put, putMany, runTx } from '~/platform/idb/database'
import { DB_NAME } from '~/platform/idb/schema'

/**
 * 账本仓库。
 *
 * 两条最要紧的断言：
 *  1. **键是外部键且来自 `recordKey()`** —— 记录里不能多出 `key` 字段，否则会被
 *     `JOB_RECORD_FIELDS` 白名单归一化清掉，读的时候键就没了。
 *  2. **淘汰发生在 upsert 的同一个事务里，且丢的是 `firstSeen` 最早的那几条** ——
 *     决策 A 的全部内容；写一条顺手淘汰，而不是攒到某次启动才全表排序。
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

/**
 * 第 `index` 条记录：`firstSeen` 按分钟递增。
 *
 * ISO 字符串的字典序即时间序，所以「序号大的更新」这一点同时决定了游标顺序，
 * 用例里的断言可以直接按序号写。
 */
function jobRecord(index: number): JobRecord {
  return {
    siteId: 'boss',
    naturalKey: `job-${index}`,
    title: `岗位 ${index}`,
    company: '某某科技',
    recruiterName: '李女士',
    salary: '20-30K',
    match: null,
    greeting: null,
    error: null,
    firstSeen: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
  }
}

beforeEach(resetDatabase)
afterEach(closeDb)
afterEach(() => vi.restoreAllMocks())

/**
 * 铺 `n` 条底数据。
 *
 * 走 `putMany`（一个事务写完）而**不是** `upsertRecord` 循环：逐条 upsert 会各开一个
 * 事务、各数一次条数，为了铺底跑两千次往返纯属浪费，也会把用例拖慢一个数量级。
 */
async function seed(n: number): Promise<void> {
  const entries: Array<Entry<JobRecord>> = []
  for (let i = 0; i < n; i++) {
    const record = jobRecord(i)
    entries.push({ key: recordKey(record), value: record })
  }
  await putMany('records', entries)
}

describe('读写', () => {
  it('写一条再读回来，键由 recordKey() 给出', async () => {
    const record = jobRecord(0)
    await upsertRecord(record)

    expect(await readRecord(record)).toEqual(record)
    // 未写过的键读回 undefined（而不是抛错）
    expect(await readRecord(jobRecord(999))).toBeUndefined()
  })

  it('读全表拿到「键 → 记录」，且记录里没有 key 字段（外部键）', async () => {
    const first = jobRecord(0)
    const second = { ...jobRecord(1), siteId: 'eleduck' }
    await upsertRecord(first)
    await upsertRecord(second)

    const all = await readAllRecords()
    expect(all).toEqual({
      [recordKey(first)]: first,
      [recordKey(second)]: second,
    })
    expect(all[recordKey(first)]).not.toHaveProperty('key')
  })

  it('同一条记录再写一次是覆盖，不是新增', async () => {
    await upsertRecord(jobRecord(0))
    await upsertRecord({ ...jobRecord(0), match: { score: 88, summary: '', reasons: [], missingSkills: [] } })

    expect(await countRecords()).toBe(1)
    expect((await readRecord(jobRecord(0)))?.match?.score).toBe(88)
  })

  it('countRecords 数条数，clearRecords 清空', async () => {
    expect(await countRecords()).toBe(0)

    await upsertRecord(jobRecord(0))
    await upsertRecord(jobRecord(1))
    expect(await countRecords()).toBe(2)

    await clearRecords()
    expect(await countRecords()).toBe(0)
    expect(await readAllRecords()).toEqual({})
  })
})

describe('容量淘汰', () => {
  it('未超上限时不动任何记录、也不打日志', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await upsertRecord(jobRecord(0))

    expect(await countRecords()).toBe(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('超过上限时丢掉最旧的：按 firstSeen 升序删溢出量', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await seed(MAX_RECORDS + 2)
    // 最后一条走 upsertRecord，用它触发淘汰
    await upsertRecord(jobRecord(MAX_RECORDS + 2))

    expect(await countRecords()).toBe(MAX_RECORDS)
    // 最旧的 3 条（序号 0/1/2）被丢掉，第 4 旧的与刚写入的都在
    expect(await readRecord(jobRecord(0))).toBeUndefined()
    expect(await readRecord(jobRecord(1))).toBeUndefined()
    expect(await readRecord(jobRecord(2))).toBeUndefined()
    expect(await readRecord(jobRecord(3))).toEqual(jobRecord(3))
    expect(await readRecord(jobRecord(MAX_RECORDS + 2))).toEqual(jobRecord(MAX_RECORDS + 2))

    expect(warn).toHaveBeenCalledWith(`[offer-hunter] 账本超过 ${MAX_RECORDS} 条，已丢弃最旧的 3 条`)
  })

  it('并发写时上限被严格遵守，且刚写进来的记录一条不丢', async () => {
    /*
     * 这正是原实现要 `serializeLedgerWrite` 的那个场景：读一条 → 写一条 → 必要时淘汰。
     * 现在靠「put 与淘汰在同一个 readwrite 事务里」保证 —— IDB 对同一仓库的事务是串行的，
     * 所以每个事务数出来的条数都是前一个提交后的值，既不会集体漏淘汰（超上限），
     * 也不会各自按同一个溢出量删（删多了）。
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await seed(MAX_RECORDS)

    const fresh = [0, 1, 2, 3, 4].map(offset => jobRecord(MAX_RECORDS + offset))
    await Promise.all(fresh.map(record => upsertRecord(record)))

    expect(await countRecords()).toBe(MAX_RECORDS)
    // 新记录 firstSeen 最新，淘汰从最旧的开始删，永远轮不到它们
    for (const record of fresh)
      expect(await readRecord(record)).toEqual(record)
    expect(warn).toHaveBeenCalled()
  })
})

describe('事务', () => {
  it('传入 ctx 时清空并入调用方事务：事务回滚，记录仍在', async () => {
    await upsertRecord(jobRecord(0))
    await put('settings', { id: 'ai', value: {}, updatedAt: 'x' })

    await expect(runTx(['records', 'settings'], 'readwrite', async (ctx) => {
      await clearRecords(ctx)
      // add 一个已存在的键 → ConstraintError → 整个事务回滚
      ctx.tx.objectStore('settings').add({ id: 'ai', value: {}, updatedAt: 'x' })
    })).rejects.toThrow()

    expect(await countRecords()).toBe(1)
  })
})
