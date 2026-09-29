import type { StoreName } from './schema'
import { DB_NAME, DB_VERSION, upgrade } from './schema'

/**
 * IndexedDB 的通用封装。
 *
 * 目标：业务代码看不到 `IDBRequest` / `IDBTransaction`，同时把 IndexedDB
 * 最容易出事的几处都收在这里处理掉。
 *
 * **三条必须守住的规矩**（改这个文件前先读一遍）：
 *
 * 1. **事务里不准 await 非 IDB 的 promise。** IDB 事务在「控制权交回事件循环」
 *    时会自动提交；await 网络请求 / 消息往返会让事务先关掉，之后的请求全部抛
 *    `TransactionInactiveError`。await 另一个 IDB 请求是安全的（微任务层面），
 *    这正是本文件所有原语的写法。
 * 2. **写事务要同时听 `request.onerror` 与 `tx.onabort`。** 只听前者会漏掉
 *    「后面某个请求失败导致整个事务回滚」的情况 —— 表现是「请求成功了但数据没了」。
 * 3. **重试只给幂等操作，且只给可重试的错误。** 见 `retryable`。
 */

export interface TxContext {
  db: IDBDatabase
  tx: IDBTransaction
}

/** 可重试的错误名：中止 / 未知错误多半来自存储压力或 SW 被回收，重试有意义 */
const RETRYABLE_ERRORS = new Set(['AbortError', 'UnknownError', 'InvalidStateError'])

const RETRY_DELAYS_MS = [50, 150]

/**
 * 有限重试。
 *
 * `ConstraintError` / `DataError` / `QuotaExceededError` **不重试** ——
 * 重试不会变好，只会把真正的问题（写坏了数据 / 配额满了）掩盖成「偶发失败」。
 */
export async function retryable<T>(op: () => Promise<T>, attempts = RETRY_DELAYS_MS.length + 1): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await op()
    }
    catch (error) {
      lastError = error
      const name = (error as { name?: string })?.name ?? ''
      if (!RETRYABLE_ERRORS.has(name) || attempt === attempts - 1)
        throw error
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt] ?? 150))
    }
  }
  throw lastError
}

/**
 * 连接单例，按需懒开。
 *
 * - SW 被回收时整个上下文都没了，句柄自然消失，不存在残留状态；
 * - 别的上下文要升级（扩展更新）时，`onversionchange` 会主动关闭并清空单例，
 *   下一次操作自动按新版本重开 —— 少了这一步，新版本的 `open` 会一直 blocked。
 */
let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openOnce().catch((error) => {
      // 失败不留下坏的单例：下次调用重新尝试
      dbPromise = null
      throw error
    })
  }
  return dbPromise
}

/** 关闭并清空单例（测试用；`onversionchange` 内部也走这里） */
export function closeDb(): void {
  const pending = dbPromise
  dbPromise = null
  void pending?.then(db => db.close()).catch(() => {})
}

function openOnce(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境没有 IndexedDB，无法使用本地存储'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = (event) => {
      upgrade(request.result, event.oldVersion, request.transaction as IDBTransaction)
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        // 别的上下文正在升级：主动让路，下次操作用新版本重开
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'))
    request.onblocked = () => {
      // 正常不该发生（上面已经主动让路）；真发生了要能查出来
      console.warn('[offer-hunter] IndexedDB 升级被阻塞：另一个标签页仍持有旧连接')
    }
  })
}

// ---------------------------------------------------------------------------
// 请求 → Promise
// ---------------------------------------------------------------------------

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}

/**
 * 等事务结束。
 *
 * 写事务必须走这一步：只等 `request.onsuccess` 是不够的 —— 事务可能在之后
 * 因为别的请求失败而整体回滚（此时 request 已经「成功」过了）。
 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'))
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
  })
}

/**
 * 开一个事务跑一段逻辑。
 *
 * ⚠ 中途抛错必须**显式 `abort()`**：不中止的话，已经发出去的写会照常提交，
 *   「事务」就只剩个名字了。
 */
async function withTx<T>(
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (ctx: TxContext) => Promise<T> | T,
): Promise<T> {
  return retryable(async () => {
    const db = await openDb()
    const tx = db.transaction(stores, mode)
    const ctx: TxContext = { db, tx }
    try {
      const result = await fn(ctx)
      // 写事务必须等它结束：只等 request.onsuccess 会漏掉整体回滚
      if (mode === 'readwrite')
        await txDone(tx)
      return result
    }
    catch (error) {
      try {
        tx.abort()
      }
      catch {
        // 事务已经结束（提交或已中止），无需再动
      }
      throw error
    }
  })
}

async function withStore<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore, tx: IDBTransaction) => T | Promise<T>,
  ctx?: TxContext,
): Promise<T> {
  // 给了上下文就并入调用方的事务（可组合、可原子）；没给就自己开一个短事务
  if (ctx)
    return fn(ctx.tx.objectStore(store), ctx.tx)

  return withTx([store], mode, inner => fn(inner.tx.objectStore(store), inner.tx))
}

// ---------------------------------------------------------------------------
// 原语
// ---------------------------------------------------------------------------

export function get<T>(store: StoreName, key: IDBValidKey, ctx?: TxContext): Promise<T | undefined> {
  return withStore(store, 'readonly', os => requestToPromise<T | undefined>(os.get(key) as IDBRequest<T | undefined>), ctx)
}

export function count(store: StoreName, ctx?: TxContext): Promise<number> {
  return withStore(store, 'readonly', os => requestToPromise<number>(os.count()), ctx)
}

/**
 * 写入。
 *
 * `key` 只在**外部键**仓库（`keyPath: null`，即 `records`）里需要传；
 * 内部键仓库传了会被忽略（IDB 会抛错，这里提前挡掉）。
 */
export function put<T>(store: StoreName, value: T, key?: IDBValidKey, ctx?: TxContext): Promise<void> {
  return withStore(store, 'readwrite', async (os) => {
    await requestToPromise(key === undefined ? os.put(value) : os.put(value, key))
  }, ctx)
}

/** 批量写的条目：外部键仓库必须给 `key`，内部键仓库不用给 */
export interface Entry<T> {
  key?: IDBValidKey
  value: T
}

export function putMany<T>(store: StoreName, entries: Array<Entry<T>>, ctx?: TxContext): Promise<void> {
  return withStore(store, 'readwrite', async (os) => {
    // 批量写刻意不逐个 await：请求一次性发出去，成败统一由事务收口（快得多）
    for (const entry of entries) {
      if (entry.key === undefined)
        os.put(entry.value)
      else
        os.put(entry.value, entry.key)
    }
  }, ctx)
}

export function del(store: StoreName, key: IDBValidKey, ctx?: TxContext): Promise<void> {
  return withStore(store, 'readwrite', async (os) => {
    os.delete(key)
  }, ctx)
}

export function clearStore(store: StoreName, ctx?: TxContext): Promise<void> {
  return withStore(store, 'readwrite', async (os) => {
    os.clear()
  }, ctx)
}

export interface IterateOptions {
  index?: string
  range?: IDBKeyRange | null
  direction?: IDBCursorDirection
  limit?: number
}

/**
 * 游标遍历（淘汰、分页、统计）。
 *
 * `limit` 到达后主动停止 —— 遍历整张表只为拿前 N 条是很常见的浪费。
 */
export function iterate<T>(
  store: StoreName,
  options: IterateOptions,
  onValue: (value: T, key: IDBValidKey) => void,
  ctx?: TxContext,
): Promise<void> {
  return withStore(store, 'readonly', (os) => {
    return new Promise<void>((resolve, reject) => {
      const source = options.index ? os.index(options.index) : os
      const request = source.openCursor(options.range ?? null, options.direction ?? 'next')
      let seen = 0

      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve()
          return
        }
        onValue(cursor.value as T, cursor.primaryKey)
        seen++
        if (options.limit !== undefined && seen >= options.limit) {
          resolve()
          return
        }
        cursor.continue()
      }
      request.onerror = () => reject(request.error ?? new Error('IndexedDB 游标失败'))
    })
  }, ctx)
}

/** 键值对（迁移校验要按键盘点整张表） */
export function getAllEntries<T>(store: StoreName, ctx?: TxContext): Promise<Array<{ key: IDBValidKey, value: T }>> {
  const entries: Array<{ key: IDBValidKey, value: T }> = []
  return iterate<T>(store, {}, (value, key) => {
    entries.push({ key, value })
  }, ctx).then(() => entries)
}

/**
 * 在一个事务里做多步操作（迁移、清空、淘汰）。
 *
 * ⚠ 传进 `fn` 的每个操作都要把 `ctx` 带上，否则它们会各自新开事务 ——
 * 那就没有原子性可言了。
 *
 * 这里**直接复用 `withTx`**，而不是自己再开一遍事务：曾经它是一份手写的副本，
 * 结果 `withTx` 后来补上了「抛错必须显式 abort」，这份副本没有跟着补 ——
 * 于是事务中途抛错时，已经发出去的写照常提交，调用方却看到失败。
 * 一份实现只有一个地方需要记住那条规矩。
 */
export function runTx<T>(
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (ctx: TxContext) => Promise<T> | T,
): Promise<T> {
  return withTx(stores, mode, fn)
}
