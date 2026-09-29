import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearStore,
  closeDb,
  count,
  del,
  get,
  getAll,
  getAllEntries,
  iterate,
  openDb,
  put,
  putMany,
  retryable,
  runTx,
} from '~/platform/idb/database'
import { DB_NAME, DB_VERSION, STORES } from '~/platform/idb/schema'

/**
 * IndexedDB 工具层。
 *
 * 这些断言对应方案里承诺的几条「高可用对策」（docs/indexeddb-migration.md §5）：
 *   - 开库建仓（含索引）与 schema 漂移
 *   - 事务原子性（中途抛错必须整体回滚）
 *   - 有限重试，且**只对可重试的错误**
 *   - 连接生命周期：显式关闭后下一次操作自动重开（对应 versionchange 让路）
 *   - 外部键 / 内部键两种仓库都能用
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

/** 让 `indexedDB.open` 失败一次，用来验证「失败不留下坏单例」 */
async function simulateOpenFailure(): Promise<void> {
  closeDb()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onblocked = () => resolve()
    request.onerror = () => resolve()
  })
}

/** 三条按时间乱序写入的账本记录（游标用例用） */
function recordsForCursor(): Array<{ key: string, value: Record<string, unknown> }> {
  return [
    { key: 'boss:c', value: { siteId: 'boss', naturalKey: 'c', firstSeen: '2026-01-03' } },
    { key: 'boss:a', value: { siteId: 'boss', naturalKey: 'a', firstSeen: '2026-01-01' } },
    { key: 'eleduck:b', value: { siteId: 'eleduck', naturalKey: 'b', firstSeen: '2026-01-02' } },
  ]
}

beforeEach(resetDatabase)
afterEach(closeDb)

describe('开库与 schema', () => {
  it('建出三个仓库与账本的两个索引', async () => {
    const db = await openDb()

    expect(db.version).toBe(DB_VERSION)
    expect([...db.objectStoreNames].sort()).toEqual(['meta', 'records', 'settings'])

    const tx = db.transaction('records', 'readonly')
    const records = tx.objectStore('records')
    expect([...records.indexNames].sort()).toEqual(['by-firstSeen', 'by-siteId'])
    expect(records.keyPath).toBeNull() // 外部键
  })

  it('schema 声明与实际建出来的库一致（防止声明改了忘了升级版本）', async () => {
    const db = await openDb()

    for (const store of STORES) {
      const tx = db.transaction(store.name, 'readonly')
      const os = tx.objectStore(store.name)
      expect([...os.indexNames].sort()).toEqual(store.indexes.map(i => i.name).sort())
      expect(os.keyPath).toBe(store.keyPath)
    }
  })

  it('重复开库拿到同一个连接（单例），关闭后下一次操作自动重开', async () => {
    const first = await openDb()
    expect(await openDb()).toBe(first)

    closeDb()
    const second = await openDb()
    expect(second).not.toBe(first)
    expect(second.version).toBe(DB_VERSION)
  })

  it('打开失败不会留下坏单例，下一次调用会重新尝试', async () => {
    // 让第一次 open 抛错：临时把 indexedDB 换成一个必然失败的实现
    await simulateOpenFailure()
    const original = globalThis.indexedDB
    const broken = {
      open: () => {
        throw new Error('boom')
      },
    } as unknown as IDBFactory
    vi.stubGlobal('indexedDB', broken)

    await expect(get('meta', 'anything')).rejects.toThrow('boom')

    vi.stubGlobal('indexedDB', original)
    // 恢复之后必须能用（证明坏单例没有被缓存住）
    await expect(get('meta', 'anything')).resolves.toBeUndefined()
  })
})

describe('原语', () => {
  it('内部键仓库：put / get / del / getAll / count', async () => {
    await put('settings', { id: 'ai', value: { platform: 'deepseek' }, updatedAt: 'now' })
    await put('settings', { id: 'resume', value: { markdown: '# 我' }, updatedAt: 'now' })

    expect(await get<{ value: { platform: string } }>('settings', 'ai')).toMatchObject({
      value: { platform: 'deepseek' },
    })
    expect(await count('settings')).toBe(2)
    expect((await getAll<{ id: string }>('settings')).map(item => item.id).sort()).toEqual(['ai', 'resume'])

    await del('settings', 'ai')
    expect(await get('settings', 'ai')).toBeUndefined()
    expect(await count('settings')).toBe(1)
  })

  it('外部键仓库：显式给键，且键不进记录本身', async () => {
    const record = { siteId: 'boss', naturalKey: 'abc', title: '前端', firstSeen: '2026-01-01' }
    await put('records', record, 'boss:abc')

    const loaded = await get<typeof record>('records', 'boss:abc')
    expect(loaded).toEqual(record)
    // 键是外部的：记录里没有 key 字段（否则 F2 的白名单归一化会把它清掉）
    expect(loaded).not.toHaveProperty('key')

    const entries = await getAllEntries<typeof record>('records')
    expect(entries).toHaveLength(1)
    expect(entries[0].key).toBe('boss:abc')
  })

  it('批量写：一次事务写入多条（外部键仓库逐条给键）', async () => {
    await putMany('records', [
      { key: 'boss:c', value: { siteId: 'boss', naturalKey: 'c', firstSeen: '2026-01-03' } },
      { key: 'boss:a', value: { siteId: 'boss', naturalKey: 'a', firstSeen: '2026-01-01' } },
      { key: 'eleduck:b', value: { siteId: 'eleduck', naturalKey: 'b', firstSeen: '2026-01-02' } },
    ])
    expect(await count('records')).toBe(3)
  })

  it('游标：按索引取、按时间升序、limit 生效', async () => {
    await putMany('records', recordsForCursor())

    const oldest: string[] = []
    await iterate<{ siteId: string, naturalKey: string }>('records', { index: 'by-firstSeen' }, (value) => {
      oldest.push(value.naturalKey)
    })
    expect(oldest).toEqual(['a', 'b', 'c'])

    const limited: string[] = []
    await iterate<{ naturalKey: string }>('records', { index: 'by-firstSeen', limit: 2 }, (value) => {
      limited.push(value.naturalKey)
    })
    expect(limited).toEqual(['a', 'b'])

    const bySite: string[] = []
    await iterate<{ naturalKey: string }>('records', {
      index: 'by-siteId',
      range: IDBKeyRange.only('boss'),
    }, (value) => {
      bySite.push(value.naturalKey)
    })
    expect(bySite.sort()).toEqual(['a', 'c'])
  })

  it('清空仓库', async () => {
    await putMany('records', recordsForCursor())
    await clearStore('records')
    expect(await count('records')).toBe(0)
  })
})

describe('事务与原子性', () => {
  it('事务里任一请求失败 → 整体回滚，先写进去的也不留', async () => {
    /*
     * 这是迁移真正依赖的性质：**任何一步出错，前面的写全部作废**。
     *
     * 触发方式选「请求失败」（add 一个已存在的键 → ConstraintError），而不是
     * 「在事务里手动 throw」：后者能否及时 abort 属于实现时序问题
     * （fake-indexeddb 在微任务排空时就提交，真实浏览器按任务边界提交），
     * 而请求失败引发的中止是规范保证的。
     *
     * 由此得到一条设计规矩：**可预见的校验一律在开事务之前做完**
     * （迁移的 planMigration 就是这么做的），事务里只放写。
     */
    await put('records', { siteId: 'boss', naturalKey: 'a', title: '旧值', firstSeen: 'x' }, 'boss:a')

    await expect(runTx(['settings', 'records'], 'readwrite', async (ctx) => {
      await put('settings', { id: 'ai', value: {}, updatedAt: 'now' }, undefined, ctx)
      // 绕过原语直接对 store 发一个必然失败的请求（原语里没有 add）
      ctx.tx.objectStore('records').add({ siteId: 'boss', naturalKey: 'a', firstSeen: 'y' }, 'boss:a')
    })).rejects.toThrow()

    expect(await count('settings')).toBe(0) // 同一事务里先写进去的也被回滚
    expect(await get('records', 'boss:a')).toMatchObject({ title: '旧值' }) // 原记录没被动
  })

  it('事务里手动抛错时错误照常抛给调用方', async () => {
    await expect(runTx(['settings'], 'readwrite', async (ctx) => {
      await put('settings', { id: 'ai', value: {}, updatedAt: 'now' }, undefined, ctx)
      throw new Error('迁移中途失败')
    })).rejects.toThrow('迁移中途失败')
  })

  it('runTx 成功时全部落库', async () => {
    await runTx(['settings', 'meta', 'records'], 'readwrite', async (ctx) => {
      await put('settings', { id: 'ai', value: {}, updatedAt: 'now' }, undefined, ctx)
      await put('meta', { key: 'migration', value: { state: 'done' } }, undefined, ctx)
      await put('records', { siteId: 'boss', naturalKey: 'a', firstSeen: 'x' }, 'boss:a', ctx)
    })

    expect(await count('settings')).toBe(1)
    expect(await count('meta')).toBe(1)
    expect(await count('records')).toBe(1)
  })

  it('单条 put 失败会抛出来，而不是静默成功', async () => {
    // records 是外部键仓库，不传键时会抛 DataError
    await expect(put('records', { siteId: 'boss' })).rejects.toThrow()
  })
})

describe('重试', () => {
  it('可重试的错误会重试到成功为止', async () => {
    let attempts = 0
    const result = await retryable(async () => {
      attempts++
      if (attempts < 3)
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('不可重试的错误立刻抛出（不掩盖真问题）', async () => {
    let attempts = 0
    await expect(retryable(async () => {
      attempts++
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
    })).rejects.toThrow('quota')

    expect(attempts).toBe(1)
  })

  it('一直失败时最终抛出，且尝试次数有上限', async () => {
    let attempts = 0
    await expect(retryable(async () => {
      attempts++
      throw Object.assign(new Error('aborted'), { name: 'UnknownError' })
    })).rejects.toThrow('aborted')

    expect(attempts).toBe(3)
  })
})
