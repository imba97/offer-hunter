/**
 * Offer Hunter 的 IndexedDB 结构声明（**唯一真相**）。
 *
 * 三处约定，改动前请先想清楚：
 *
 * 1. **库名与版本号都不能随便改。** 库名换了等于丢数据；版本号只能往上加，
 *    并且每次都只能在 `upgrade()` 里**追加**一个 `if (oldVersion < N)` 分支 ——
 *    改旧分支会让老用户与新用户走出两种不同的库结构。
 * 2. **`records` 用「外部键」（`createObjectStore` 不带 keyPath），不是把键塞进记录里。**
 *    原因是账本记录的字段由 `JOB_RECORD_FIELDS` 白名单守着，多一个 `key` 字段会被
 *    归一化当成未知字段清掉。键仍然沿用 `recordKey()` 的 `<siteId>:<naturalKey>`。
 * 3. **`settings` / `meta` 用「内部键」**（`id` / `key`），因为它们本来就是单文档。
 */

export const DB_NAME = 'offer-hunter'

/**
 * 当前 schema 版本。
 *
 * 每次改动结构都要 +1，并在 `upgrade()` 里追加对应分支。
 */
export const DB_VERSION = 1

export type StoreName = 'settings' | 'records' | 'meta'

export interface IndexSchema {
  name: string
  keyPath: string
}

export interface StoreSchema {
  name: StoreName
  /** 内部键的字段名；`null` 表示用外部键（写入时必须显式给键） */
  keyPath: string | null
  indexes: IndexSchema[]
}

export const STORES: readonly StoreSchema[] = [
  {
    // 单文档仓库：ai / resume / prompts，值统一是 { id, value, updatedAt }
    name: 'settings',
    keyPath: 'id',
    indexes: [],
  },
  {
    // 岗位账本：一条记录一个条目
    name: 'records',
    keyPath: null,
    indexes: [
      // 淘汰用：按首次记录时间升序游标删最旧的
      { name: 'by-firstSeen', keyPath: 'firstSeen' },
      // 为将来的「投递记录面板」按站点筛选
      { name: 'by-siteId', keyPath: 'siteId' },
    ],
  },
  {
    // 迁移与自检记录：migration / schema
    name: 'meta',
    keyPath: 'key',
    indexes: [],
  },
]

/**
 * 建库 / 升级。
 *
 * ⚠ 只追加分支，不改已有分支。每个分支内部**只做结构性操作**
 *   （建仓库、建索引），数据搬迁交给应用层（见 `logic/store/legacy.ts`）：
 *   放在这里做的话，一旦中途失败，用户会得到一个「建了库但没数据」的状态，
 *   而应用层的一次性迁移是原子的、可重试的。
 */
export function upgrade(db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void {
  if (oldVersion < 1) {
    for (const store of STORES) {
      const created = store.keyPath
        ? db.createObjectStore(store.name, { keyPath: store.keyPath })
        : db.createObjectStore(store.name)
      for (const index of store.indexes)
        created.createIndex(index.name, index.keyPath)
    }
    return
  }

  // 以后新增版本时在这里追加，例如：
  // if (oldVersion < 2) { tx.objectStore('records').createIndex('by-score', 'score') }
  void tx
}
