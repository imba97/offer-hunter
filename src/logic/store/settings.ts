import type { TxContext } from '~/platform/idb/database'
import { get, put } from '~/platform/idb/database'
import { mergeDefaults } from './migrations'

/**
 * `settings` 仓库里的三个单文档：ai / resume / prompts。
 *
 * 三者语义完全相同（读一个文档 → 补默认值 → 写回），所以共用一个仓库、共用这三个
 * 函数 —— 「清空」与「将来再加一类设置」都只是一行。仓库形状见
 * platform/idb/schema.ts 与 docs/indexeddb-migration.md §4.1。
 *
 * ⚠ 这一层只管「取出来 / 放进去」，**不做领域归一化**：简历的 legacy 形状
 *   （`gist` → `sources.gist`）与账本的键改名都在 `migrations.ts` 的纯函数里，
 *   由门面 `storage.ts` 决定在哪一步调用。归一化混进这里，干跑预览（它只渲染纯函数
 *   的产物）与真实迁移就会走出两条不同的路。
 */

export type SettingId = 'ai' | 'resume' | 'prompts'

/**
 * 文档形状。
 *
 * `value` 刻意是 `unknown`：库里可能躺着旧形状的值，甚至是被 JSON 字符串化过的
 * 字符串（早期版本用模板的 useWebExtensionStorage 就这么写过），读的一方必须先
 * 走 `mergeDefaults`（它内部会先复活字符串）—— 在这里声明成具体类型只会掩盖这件事。
 */
export interface SettingDoc {
  id: SettingId
  value: unknown
  updatedAt: string
}

/** 读原始文档值（可能是 undefined、旧形状、或 JSON 字符串）；不做任何归一 */
export async function readRawSetting(id: SettingId): Promise<unknown> {
  const doc = await get<SettingDoc>('settings', id)
  return doc?.value
}

/** 读并补齐默认值：mergeDefaults(raw, fallback) */
export async function readSetting<T>(id: SettingId, fallback: T): Promise<T> {
  return mergeDefaults(await readRawSetting(id), fallback)
}

/**
 * 写文档（ctx 用于并入调用方事务，见 platform/idb 的 put 参数顺序：store, value, key, ctx）。
 *
 * `updatedAt` 在这里统一盖：调用方拿不到写时间，也就写不出不一致的时间戳。
 * 键的位置固定传 `undefined` —— settings 是内部键仓库（keyPath 为 'id'），
 * 多传一个键 IDB 会直接抛错。
 */
export async function writeSetting(id: SettingId, value: unknown, ctx?: TxContext): Promise<void> {
  const doc: SettingDoc = { id, value, updatedAt: new Date().toISOString() }
  await put('settings', doc, undefined, ctx)
}
