import type { JobRecord } from '~/logic/types'
import type { TxContext } from '~/platform/idb/database'
import { recordKey } from '~/logic/types'
import { clearStore, count, del, get, getAllEntries, iterate, put, runTx } from '~/platform/idb/database'

/**
 * 岗位账本（`records` 仓库）。
 *
 * 一条记录一个条目，用**外部键**（keyPath 为 null，键由 `recordKey()` 给出）。外部键
 * 是刻意的：`JobRecord` 的字段由 `JOB_RECORD_FIELDS` 白名单守着，往记录里塞一个 `key`
 * 字段会被归一化当成未知字段清掉（见 platform/idb/schema.ts 的说明）。
 *
 * 与改造前「一个键装整张表」的差别就是这一层的全部意义：
 *   - 写一条 = 写一条，不再是「读整表 → 改一条 → 写整表」的 1–3MB 写放大；
 *   - 淘汰 = 按 `firstSeen` 索引游标取最旧的 N 条，不再把整表读进内存排序；
 *   - 并发 = IDB 对同一仓库的 readwrite 事务天然串行，不再需要那条只锁得住单个
 *     JS 上下文的 `ledgerWriteChain`（存储层改造 §8 明确删掉它）。
 */

/** 与改造前的上限一致（决策 A：上限不变，只把淘汰换成索引游标） */
export const MAX_RECORDS = 2000

/**
 * 读一条。
 *
 * 参数收窄成「只要有身份」而不是整条 `JobRecord`：调用方（侧边栏按当前岗位查记录）
 * 手上通常只有 `siteId` + `naturalKey`，凑一条完整记录纯属为了过类型。
 * 对传整条记录的调用方向后兼容。
 *
 * TODO(过渡代码)：目前**没有生产调用方** —— 它是为决策 B（侧边栏按当前岗位读一条）
 * 准备的，而决策 B 尚未落地；面板暂时仍走 `readAllRecords`。
 * 若决策 B 最终不做，这里就是死代码，见 docs/transitional-code.md（第一批）。
 */
export function readRecord(record: Pick<JobRecord, 'siteId' | 'naturalKey'>): Promise<JobRecord | undefined> {
  return get<JobRecord>('records', recordKey(record))
}

/**
 * 读全表（键 → 记录），供侧边栏当前的 get-records 使用。
 *
 * 用 `getAllEntries` 而不是 `getAll` 再按记录反推键：键是外部键，记录里没有它，
 * 反推要求 `siteId` / `naturalKey` 两个字段都完好 —— 而这条路径恰恰是**归一化之前**
 * 的入口，脏数据会因此拿不到自己的键。直接取真键，什么样的记录都读得回来。
 */
export async function readAllRecords(): Promise<Record<string, JobRecord>> {
  const entries = await getAllEntries<JobRecord>('records')
  const all: Record<string, JobRecord> = {}
  for (const { key, value } of entries)
    all[String(key)] = value
  return all
}

/**
 * 写一条并在**同一个事务**里按容量淘汰（决策 A）。
 *
 * 为什么必须是同一个事务：淘汰要先 `count` 再删，拆成两个事务的话，两个上下文并发
 * 写时会各自数出「还没超限」而双双留下条目，或者各自按同一个溢出量删 —— 前者突破
 * 上限，后者多删。放进一个 readwrite 事务后，这一整串操作对同一仓库是串行的，
 * 不需要任何额外的锁。（旧实现为了同样的目的用了 `serializeLedgerWrite`，
 * 而它只锁得住单个 JS 上下文，跨上下文照样丢写。）
 *
 * ⚠ 事务里的每个原语都要把 `ctx` 传进去：不传就等于各自新开一个短事务，
 *   原子性当场消失（`platform/idb/database.ts` 头部第 1 条规矩）。
 */
export async function upsertRecord(record: JobRecord): Promise<void> {
  await runTx(['records'], 'readwrite', async (ctx) => {
    await put('records', record, recordKey(record), ctx)
    await pruneOverflow(ctx)
  })
}

/**
 * 删掉超出上限的条目，从最旧的开始。
 *
 * 不需要排序：`firstSeen` 是 ISO 字符串，字典序即时间序，所以 `by-firstSeen` 索引
 * 升序游标的前 N 条就是最旧的 N 条。溢出量由 `count` 算，游标取到量就停 —— 遍历整张
 * 表只为删几条是纯粹的浪费。
 *
 * 关于 `del` 不 await：`iterate` 的回调是同步的，而 `del` 在拿到 `ctx` 时是**同步**把
 * `os.delete()` 发出去的（它返回的 promise 没人等也无妨）—— 请求落在同一个事务里就够
 * 了，事务何时提交由 `runTx` 统一等。反过来，回调里若去 await 别的东西，事务会在微任务
 * 排空时提前提交（`platform/idb/database.ts` 头部第 1 条规矩）。
 *
 * 记录若连 `firstSeen` 字段都没有就不在这个索引里，也就不会被淘汰；归一化不会产出
 * 这种记录（`str()` 至少给空串），所以这里不为它加兜底。
 */
async function pruneOverflow(ctx: TxContext): Promise<void> {
  const total = await count('records', ctx)
  const overflow = total - MAX_RECORDS
  if (overflow <= 0)
    return

  await iterate<JobRecord>(
    'records',
    { index: 'by-firstSeen', direction: 'next', limit: overflow },
    (_value, key) => {
      void del('records', key, ctx)
    },
    ctx,
  )

  console.warn(`[offer-hunter] 账本超过 ${MAX_RECORDS} 条，已丢弃最旧的 ${overflow} 条`)
}

/** 一天的毫秒数（保留天数的换算基准） */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 按时间清理账本（设置项 `retention.days`）。
 *
 * 判据是 **`firstSeen`**（首次记录时间）而不是「最近使用」：后者需要给记录加
 * `lastSeen` 并建索引（schema 升到 v2）。因此设置页与隐私政策里的措辞必须一致
 * ——「按首次看到该岗位的时间清理」。
 *
 * 用 `IDBKeyRange.upperBound(cutoff)` 只扫**过期的前缀**：`by-firstSeen` 是升序索引，
 * 只要日期在 cutoff 之前就都在开头这一段里，不需要遍历全表。
 *
 * `days <= 0` 直接不做（默认值就是 0 = 永不按时间清理）。返回删掉的条数，供日志与测试。
 */
export async function pruneByAge(days: number): Promise<number> {
  if (!Number.isFinite(days) || days <= 0)
    return 0

  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString()
  let removed = 0

  await runTx(['records'], 'readwrite', async (ctx) => {
    await iterate<JobRecord>(
      'records',
      { index: 'by-firstSeen', range: IDBKeyRange.upperBound(cutoff), direction: 'next' },
      (_value, key) => {
        void del('records', key, ctx)
        removed++
      },
      ctx,
    )
  })

  if (removed > 0)
    console.warn(`[offer-hunter] 账本按保留策略（${days} 天）清理了 ${removed} 条`)

  return removed
}

/** 条数（迁移校验用） */
export function countRecords(): Promise<number> {
  return count('records')
}

/** 清空（resetAllStorage 用） */
export function clearRecords(ctx?: TxContext): Promise<void> {
  return clearStore('records', ctx)
}
