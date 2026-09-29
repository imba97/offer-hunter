import type { Ref } from 'vue'
import type { SettingId } from './store/settings'
import type { AiSettings, JobRecord, PromptSettings, Resume } from './types'
import { getCurrentScope, onScopeDispose, ref, watch } from 'vue'
import { storage } from 'webextension-polyfill'
import { clearStore, runTx } from '~/platform/idb/database'
import { notifyStoreChange, onStoreChange } from './store/events'
import { STORAGE_KEYS } from './store/legacy'
import { mergeDefaults, normalizeRecordShape, normalizeResumeDoc } from './store/migrations'
import { ensureStoreReady } from './store/ready'
import { clearRecords, readAllRecords, upsertRecord as writeRecord } from './store/records'
import { readRawSetting, readSetting, writeSetting } from './store/settings'
import { createDefaultAiSettings, createDefaultPromptSettings, recordKey } from './types'

/**
 * 存储层的**唯一门面**。数据落在扩展自己的 IndexedDB 里
 * （结构见 `platform/idb/schema.ts`，迁移见 `logic/store/legacy.ts`）。
 *
 * 这个文件的设计目标是「换引擎，不换契约」：导出的函数名与语义与改造前一致，
 * 调用方（后台、设置页、侧边栏）不需要知道底下换成了 IndexedDB。
 *
 * 三条规矩：
 *  1. **每个读写的第一行都是 `await ensureStoreReady()`** —— 那是初始化门闸，
 *     保证不会有人读到「迁移跑了一半」的状态（旧实现靠"读的时候顺便归一"兜，
 *     能用但很脆）。
 *  2. **写之后必须 `notifyStoreChange()`** —— IndexedDB 没有变更事件，跨上下文
 *     同步全靠这条广播（旧的 `storage.onChanged` 的替代品）。
 *  3. **写进库的记录必须是当前形状** —— 入库前统一过一遍归一化，库里因此只会有
 *     一种记录形状（决策 F2），将来的统计面板不用兼容历史字段。
 *
 * 改造前遗留的东西**只在这个文件里出现一次**：`resetAllStorage` 顺手删掉旧的
 * chrome.storage 键（用户装回过旧版本时才会存在）。
 *
 * TODO(过渡代码)：上面那句「顺手删旧键」、`STORAGE_KEYS` 的导入，以及
 * `manifest.ts` 里的 `storage` 权限，都是过渡代码，见 docs/transitional-code.md（第二批）。
 */

/** 让页面侧继续用同一个名字拿到设置文档的 id 类型 */
export type { SettingId }

// ---------------------------------------------------------------------------
// AI 设置
// ---------------------------------------------------------------------------

export async function readAiSettings(): Promise<AiSettings> {
  await ensureStoreReady()
  return readSetting<AiSettings>('ai', createDefaultAiSettings())
}

export async function writeAiSettings(value: AiSettings): Promise<void> {
  await ensureStoreReady()
  await writeSetting('ai', value)
  notifyStoreChange('ai')
}

// ---------------------------------------------------------------------------
// 简历
// ---------------------------------------------------------------------------

export async function readResume(): Promise<Resume> {
  await ensureStoreReady()
  return normalizeResumeDoc(await readRawSetting('resume'))
}

export async function writeResume(value: Resume): Promise<void> {
  await ensureStoreReady()
  await writeSetting('resume', value)
  notifyStoreChange('resume')
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

export async function readPromptSettings(): Promise<PromptSettings> {
  await ensureStoreReady()
  return readSetting<PromptSettings>('prompts', createDefaultPromptSettings())
}

export async function writePromptSettings(value: PromptSettings): Promise<void> {
  await ensureStoreReady()
  await writeSetting('prompts', value)
  notifyStoreChange('prompts')
}

// ---------------------------------------------------------------------------
// 岗位账本
// ---------------------------------------------------------------------------

export async function readRecords(): Promise<Record<string, JobRecord>> {
  await ensureStoreReady()
  return readAllRecords()
}

/**
 * 写一条账本记录。
 *
 * 容量与淘汰在 `store/records.ts` 里（写与淘汰同一个事务），这里只负责
 * 「先归一化再入库」这一层门面职责。
 */
export async function upsertRecord(record: JobRecord): Promise<void> {
  await ensureStoreReady()

  // 归一化是就地改的，所以借一张单条表过一遍；库里只允许存在当前形状的记录
  const single: Record<string, JobRecord> = { [recordKey(record)]: record }
  normalizeRecordShape(single)
  await writeRecord(single[recordKey(record)])

  notifyStoreChange('records')
}

// ---------------------------------------------------------------------------
// 响应式封装（Vue 侧）
// ---------------------------------------------------------------------------

/** 写入节流窗口：Monaco 每敲一个字符都会改值，逐字符落盘没有必要 */
const WRITE_DEBOUNCE_MS = 400

/**
 * 按 id 取归一化后的设置值。
 *
 * 简历要跑完整归一（补来源配置、搬 legacy 字段），其余两个只是补齐默认值 ——
 * 「每个已注册来源都必须有完整形状的配置」这条约束原来由启动时的
 * `ensureStorageDefaults` 落盘保证，现在改成**读时保证**：少一次写，
 * 而且不会因为启动顺序不同而出现"有时有、有时没有"。
 */
function normalizeSetting(id: SettingId, raw: unknown, fallback: () => object): object {
  if (id === 'resume')
    return normalizeResumeDoc(raw)
  return mergeDefaults(raw, fallback())
}

/**
 * 把某个设置文档包成响应式 ref，并与存储双向同步。
 *
 * 与改造前的差异只有一处：**跨上下文同步从 `storage.onChanged` 换成
 * `onStoreChange` 广播**（IndexedDB 没有变更事件）。其余三处踩过的坑照旧要防：
 *
 * 1. **回声**：广播由后台发出，所以**写入方自己也会收到**。若把回调值直接赋回
 *    ref，就成了「写入 → 回调 → 赋值 → 写入」的自激循环。因此用 `synced` 记住
 *    「已与存储一致」的序列化值，回声与它相同就直接忽略。
 * 2. **节流**：deep watch 会在每次输入时触发，写入必须 debounce，并在页面卸载 /
 *    组件卸载时补一次落盘。
 * 3. **监听器生命周期**：侧边栏里切换标签会反复挂载子组件，不注销就会累积
 *    一组组僵尸监听器（它们还会继续往存储回写）。
 *
 * 新增的一条：`cleared` 广播**会被送达**（旧的 `storage.onChanged` 忽略删除事件），
 * 收到后把 ref 重置为默认值 —— 于是「清空数据后要刷新页面才生效」这个瑕疵没有了。
 */
export function useStoredValue<T extends object>(
  id: SettingId,
  fallback: () => T,
): Ref<T> {
  const state = ref(fallback()) as Ref<T>

  /** 最近一次「已经与存储一致」的序列化值 */
  let synced = JSON.stringify(state.value)
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  /** 应用一份来自存储的值（初次读取、或其他上下文的改动） */
  function applyIncoming(raw: unknown): void {
    const merged = normalizeSetting(id, raw, fallback) as T
    const next = JSON.stringify(merged)
    if (next === synced)
      return
    // 先记录再赋值：否则下面的 watch 会把它当成用户的真实改动写回去
    synced = next
    state.value = merged
  }

  /** 立刻落盘（若与存储不一致） */
  function flush(value: T): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const next = JSON.stringify(value)
    if (next === synced)
      return
    synced = next
    writeSetting(id, value)
      .then(() => notifyStoreChange(id))
      .catch((error) => {
        // 写失败要把「已同步」的标记退回去，否则界面会以为已经存上了
        synced = ''
        console.error(`[offer-hunter] 写入设置 ${id} 失败`, error)
      })
  }

  function load(): void {
    ensureStoreReady()
      .then(() => readRawSetting(id))
      .then((raw) => {
        if (!disposed)
          applyIncoming(raw)
      })
      .catch((error) => {
        console.error(`[offer-hunter] 读取设置 ${id} 失败`, error)
      })
  }

  load()

  watch(state, (value) => {
    if (JSON.stringify(value) === synced)
      return
    if (timer)
      clearTimeout(timer)
    timer = setTimeout(flush, WRITE_DEBOUNCE_MS, state.value)
  }, { deep: true, flush: 'post' })

  // 其他上下文改动时同步过来（例如面板改了配置，设置页立即反映）
  const off = onStoreChange(id, (kind) => {
    if (kind === 'cleared') {
      const reset = fallback()
      synced = JSON.stringify(reset)
      state.value = reset
      return
    }
    load()
  })

  // 扩展页随时可能被直接关掉，关页前把待写入的改动落盘
  const onPageHide = () => flush(state.value)
  window.addEventListener('pagehide', onPageHide)

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true
      flush(state.value)
      off()
      window.removeEventListener('pagehide', onPageHide)
    })
  }

  return state
}

// ---------------------------------------------------------------------------
// 重置
// ---------------------------------------------------------------------------

/**
 * 清空全部扩展数据（设置页的「清空本地数据」）。
 *
 * 一个事务清掉两个仓库；`meta` 里的迁移标记**刻意保留** —— 清空后旧键也没了，
 * 标记留着才不会让下次启动又把「已迁移」的判定重跑一遍。
 *
 * 顺手删一次旧的 chrome.storage 键：正常情况它们已不存在，只有「用户装回过
 * 旧版本」时才会又出现（那种情况下不删就等于清空没清干净）。
 */
export async function resetAllStorage(): Promise<void> {
  await ensureStoreReady()

  await runTx(['settings', 'records'], 'readwrite', async (ctx) => {
    await clearStore('settings', ctx)
    await clearRecords(ctx)
  })

  try {
    await storage.local.remove(Object.values(STORAGE_KEYS))
  }
  catch {
    // 没有旧键可删（或 storage 不可用）都不该让清空失败
  }

  for (const id of ['ai', 'resume', 'prompts', 'records'] as const)
    notifyStoreChange(id, 'cleared')
}
