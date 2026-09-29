import type { RetentionSettings } from '~/logic/types'
import { runMigration } from '~/logic/store/legacy'
import { pruneByAge } from '~/logic/store/records'
import { readSetting } from '~/logic/store/settings'
import { createDefaultRetentionSettings } from '~/logic/types'
import { openDb } from '~/platform/idb/database'

/**
 * 初始化门闸。
 *
 * **所有存储读写都必须先 `await ensureStoreReady()`**（门面 `logic/storage.ts`
 * 里每个读写函数的第一行都是它）。这样做的意义：
 *
 *  - 消除「读到迁移跑了一半」的窗口。改造前的实现没有门闸，靠「读的时候顺便归一」
 *    兜住，能用但很脆（见 docs/indexeddb-migration.md §3.1）；
 *  - 把「开库 → 请求持久化 → 一次性迁移」的顺序固定在一处，谁先谁后不用再猜。
 *
 * 失败**不缓存**：下一次调用会重新走一遍初始化（含迁移重试）。
 * 迁移失败时这里会抛 —— 宁可让操作失败得明确，也不要让用户面对一个空库
 * 却以为数据没了（旧数据这时仍然完整地留在 chrome.storage.local 里）。
 */
let readyPromise: Promise<void> | null = null

export function ensureStoreReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = init().catch((error) => {
      readyPromise = null
      throw error
    })
  }
  return readyPromise
}

async function init(): Promise<void> {
  await openDb()
  await requestPersistence()

  const result = await runMigration()
  if (result.status === 'failed')
    throw new Error(`存储迁移失败：${result.error ?? '未知原因'}`)

  if (result.status === 'migrated') {
    // eslint-disable-next-line no-console
    console.log(`[offer-hunter] 已迁移到 IndexedDB：${result.counts?.records ?? 0} 条岗位记录`)
  }

  await pruneLedgerByRetention()
}

/**
 * 按保留策略清一次账本（默认 `days: 0` = 不做）。
 *
 * 放在初始化而不是写入路径：这是「按天」的清理，跟着每次写入跑没有意义；而初始化
 * 在每个上下文只做一次，页面与后台不论谁先起来都会清一遍（清理幂等、且在事务里做，
 * 两个上下文同时跑也只有一个真正删到东西）。
 *
 * ⚠ 这里直接读 store 层的设置，**不走门面 `logic/storage.ts`** ——
 *   门面依赖本模块（`ensureStoreReady`），反过来依赖就成环了。
 */
async function pruneLedgerByRetention(): Promise<void> {
  const settings = await readSetting<RetentionSettings>('retention', createDefaultRetentionSettings())
  await pruneByAge(settings.days)
}

/**
 * 请求持久化存储。
 *
 * IndexedDB 在磁盘压力下**可能被浏览器回收**，`persist()` 能挡住这件事。
 * 拿不到也没关系（返回值可能为 false），所以全程不抛错、不影响功能。
 * 刻意不申请 `unlimitedStorage` 权限：IDB 配额本就远大于旧存储的 10MB，
 * 而那个权限会加宽安装提示（决策 C）。
 */
async function requestPersistence(): Promise<void> {
  try {
    await globalThis.navigator?.storage?.persist?.()
  }
  catch {
    // 不支持就算了
  }
}

/**
 * 仅供测试：清掉「已就绪」的缓存，让下一次调用重新初始化。
 *
 * 生产代码不该调用它 —— 初始化只做一次是这里的全部意义。
 */
export function resetStoreReadyForTests(): void {
  readyPromise = null
}
