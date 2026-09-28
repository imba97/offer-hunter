import type { Ref } from 'vue'
import type {
  AiSettings,
  JobRecord,
  MatchingSettings,
  Resume,
} from './types'
import { getCurrentScope, onScopeDispose, ref, watch } from 'vue'
import { storage } from 'webextension-polyfill'
import {
  createDefaultAiSettings,
  createDefaultMatchingSettings,
  createEmptyResume,
} from './types'

/**
 * storage.local 读写。
 *
 * ⚠ 这里刻意不使用模板自带的 useWebExtensionStorage：它会把值 JSON 序列化成
 * **字符串**再写入，而 service worker 侧是直接 storage.local.get 的。
 * 两侧格式不一致会导致后台把字符串当对象读 —— 表现为「明明配了却报未配置」。
 *
 * 因此统一由本模块负责读写，Vue 侧用 useStoredValue 包一层响应式，
 * 保证后台与页面看到的数据格式完全一致（都存原生对象）。
 *
 * ⚠ 安全提示（已在设置页向用户明示）：chrome.storage.local **不加密**，
 * 能读取本机磁盘上浏览器数据的人即可拿到其中的 API Key。
 */

const KEY_AI = 'offer-hunter-ai'
const KEY_RESUME = 'offer-hunter-resume'
const KEY_MATCHING = 'offer-hunter-matching'
const KEY_RECORDS = 'offer-hunter-records'

export const STORAGE_KEYS = {
  ai: KEY_AI,
  resume: KEY_RESUME,
  matching: KEY_MATCHING,
  records: KEY_RECORDS,
} as const

/**
 * 兼容历史上被 JSON 字符串化的存量数据。
 *
 * 早期版本用的是模板自带的 useWebExtensionStorage，它会把值 JSON.stringify
 * 成**字符串**再写入。这里必须先把字符串解析回对象，否则下面 mergeDefaults 的
 * `typeof value !== 'object'` 分支会直接把字符串原样返回 —— 合并完全不发生，
 * 后续读 apiKey 之类的字段就全是 undefined。
 */
function reviveLegacyString(value: unknown): unknown {
  if (typeof value !== 'string')
    return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('['))
    return value
  try {
    return JSON.parse(trimmed)
  }
  catch {
    return value
  }
}

/**
 * 用默认值补齐存储对象的缺失字段，并丢掉默认值里已不存在的字段。
 *
 * 为什么必须有：`read` 以前是「存储里有值就整体替换默认值」，于是任何**字段不全**
 * 的旧数据都会让后续代码拿到 undefined —— 典型表现是设置页读 `apiKey.trim()`
 * 直接抛 "Cannot read properties of undefined (reading 'trim')"。
 *
 * 为什么还要裁剪：只做「以存储为准」的合并会把**已删除的字段**一直留在对象里，
 * 还会被写回存储（例如移除「求职偏好」后，旧数据里的 `basics` 会一直跟着）。
 * 因此以 fallback 的键为准：fallback 是什么形状，结果就是什么形状。
 *
 * ⚠ 前提是每个存储键都有完整的默认值形状。记录账本 `{}` 这种「动态键映射」
 * 因为 fallback 没有键，会自动跳过裁剪（否则会把整张表清空）。
 *
 * 导出是为了单测：这是迁移逻辑的核心，出错的症状（读到 undefined）离原因很远。
 */
export function mergeDefaults<T>(value: unknown, fallback: T): T {
  const source = reviveLegacyString(value)
  if (source === undefined || source === null)
    return fallback
  if (Array.isArray(fallback))
    return (Array.isArray(source) ? source : fallback) as T
  if (typeof fallback !== 'object' || typeof source !== 'object')
    return source as T

  const fb = fallback as Record<string, unknown>
  const src = source as Record<string, unknown>

  // fallback 没有声明任何键（动态映射，如记录账本），此时不能裁剪
  const keys = Object.keys(fb)
  if (keys.length === 0)
    return source as T

  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const v = src[k]
    if (v === undefined) {
      out[k] = fb[k]
      continue
    }
    out[k] = (v !== null && typeof v === 'object' && !Array.isArray(v))
      ? mergeDefaults(v, fb[k] ?? {})
      : reviveLegacyString(v)
  }
  return out as T
}

async function read<T>(key: string, fallback: T): Promise<T> {
  const res = await storage.local.get(key)
  return mergeDefaults(res[key], fallback)
}

// ---------------------------------------------------------------------------
// AI 设置
// ---------------------------------------------------------------------------

export function readAiSettings(): Promise<AiSettings> {
  return read<AiSettings>(KEY_AI, createDefaultAiSettings())
}

export function writeAiSettings(value: AiSettings): Promise<void> {
  return storage.local.set({ [KEY_AI]: value })
}

// ---------------------------------------------------------------------------
// 简历
// ---------------------------------------------------------------------------

export function readResume(): Promise<Resume> {
  return read<Resume>(KEY_RESUME, createEmptyResume())
}

export function writeResume(value: Resume): Promise<void> {
  return storage.local.set({ [KEY_RESUME]: value })
}

// ---------------------------------------------------------------------------
// 招呼语生成配置
// ---------------------------------------------------------------------------

export function readMatchingSettings(): Promise<MatchingSettings> {
  return read<MatchingSettings>(KEY_MATCHING, createDefaultMatchingSettings())
}

export function writeMatchingSettings(value: MatchingSettings): Promise<void> {
  return storage.local.set({ [KEY_MATCHING]: value })
}

// ---------------------------------------------------------------------------
// 岗位记录账本
// ---------------------------------------------------------------------------

/**
 * 以 securityId 为键。
 *
 * 这张表是刚需而非优化：没有它，每次刷新都会对同一批岗位重复打招呼，
 * 既浪费配额，也是风控触发点。
 */
export function readRecords(): Promise<Record<string, JobRecord>> {
  return read<Record<string, JobRecord>>(KEY_RECORDS, {})
}

/**
 * 账本写入串行化。
 *
 * upsertRecord 是「读整表 → 改一条 → 写整表」，而 service worker 是**并发**
 * 处理消息的（多窗口各有一个侧边栏时尤其明显）：两次写入交错就会互相覆盖，
 * 丢掉其中一条记录。用一个 promise 链把它们排队即可，开销可忽略。
 */
let ledgerWriteChain: Promise<unknown> = Promise.resolve()

function serializeLedgerWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = ledgerWriteChain.then(task, task)
  ledgerWriteChain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 账本上限。
 *
 * 表只增不减的话，长期使用（加上以后要做的投递记录面板）会一路撞上
 * storage.local 的配额 —— 那时的表现是所有写入静默失败，而不是表变大。
 * 超限时按 firstSeen 丢掉最旧的记录；代价仅仅是极久以前的岗位可能被重新分析。
 */
const MAX_RECORDS = 2000

function pruneRecords(all: Record<string, JobRecord>): Record<string, JobRecord> {
  const keys = Object.keys(all)
  if (keys.length <= MAX_RECORDS)
    return all

  // firstSeen 是 ISO 字符串，字典序即时间序
  const oldestFirst = keys.sort((a, b) => (all[a]?.firstSeen ?? '').localeCompare(all[b]?.firstSeen ?? ''))
  const dropped = oldestFirst.slice(0, keys.length - MAX_RECORDS)
  for (const key of dropped)
    delete all[key]

  console.warn(`[offer-hunter] 账本超过 ${MAX_RECORDS} 条，已丢弃最旧的 ${dropped.length} 条`)
  return all
}

export function upsertRecord(record: JobRecord): Promise<void> {
  return serializeLedgerWrite(async () => {
    const all = await readRecords()
    all[record.securityId] = record
    await storage.local.set({ [KEY_RECORDS]: pruneRecords(all) })
  })
}

// ---------------------------------------------------------------------------
// Vue 侧响应式封装
// ---------------------------------------------------------------------------

/** 写入节流窗口：Monaco 每敲一个字符都会改值，逐字符落盘没有必要 */
const WRITE_DEBOUNCE_MS = 400

/**
 * 把某个存储键包成响应式 ref，并与 storage.local 双向同步。
 *
 * 与模板 composable 的关键差异：**存取的都是原生对象，不做 JSON 字符串化**，
 * 从而与 service worker 侧的 readXxx / writeXxx 完全一致。
 *
 * 三处必须小心的地方（都踩过）：
 *
 * 1. **回声**：自己写入后 storage.onChanged 也会回调。若把回调值直接赋回 ref，
 *    就成了「写入 → 回调 → 赋值 → 写入」的自激循环。Chrome 对未变化的 set
 *    不派发事件（只多写一轮），Firefox 无论如何都派发，会变成停不下来的写循环
 *    （见 w3c/webextensions#511）。因此用 `synced` 记住「已与存储一致」的序列化值，
 *    回声与它相同就直接忽略；它同时避免了旧的快照回灌、覆盖用户刚敲的内容。
 * 2. **节流**：deep watch 会在每次输入时触发，写入必须 debounce，并在页面卸载 /
 *    组件卸载时补一次落盘。
 * 3. **监听器生命周期**：侧边栏里切换标签会反复挂载子组件，不注销就会累积
 *    一组组僵尸监听器（它们还会继续往存储回写）。
 */
export function useStoredValue<T extends object>(
  key: string,
  fallback: () => T,
): Ref<T> {
  const state = ref(fallback()) as Ref<T>

  /** 最近一次「已经与存储一致」的序列化值 */
  let synced = JSON.stringify(state.value)
  let timer: ReturnType<typeof setTimeout> | null = null

  /** 应用一份来自存储的值（初次读取、或其他上下文的改动） */
  function applyIncoming(raw: unknown): void {
    const merged = mergeDefaults(raw, fallback())
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
    storage.local.set({ [key]: value }).catch((error) => {
      console.error(`[offer-hunter] 写入 ${key} 失败`, error)
    })
  }

  storage.local.get(key).then((res) => {
    applyIncoming(res[key])
  }).catch((error) => {
    console.error(`[offer-hunter] 读取 ${key} 失败`, error)
  })

  watch(state, (value) => {
    if (JSON.stringify(value) === synced)
      return
    if (timer)
      clearTimeout(timer)
    timer = setTimeout(flush, WRITE_DEBOUNCE_MS, state.value)
  }, { deep: true, flush: 'post' })

  // 其他上下文改动时同步过来（例如面板改了阈值，设置页立即反映）
  const onChange = (changes: Record<string, { newValue?: unknown }>) => {
    const change = changes[key]
    if (change && change.newValue !== undefined)
      applyIncoming(change.newValue)
  }
  storage.onChanged.addListener(onChange)

  // 扩展页随时可能被直接关掉，关页前把待写入的改动落盘
  const onPageHide = () => flush(state.value)
  window.addEventListener('pagehide', onPageHide)

  if (getCurrentScope()) {
    onScopeDispose(() => {
      flush(state.value)
      storage.onChanged.removeListener(onChange)
      window.removeEventListener('pagehide', onPageHide)
    })
  }

  return state
}

/**
 * 抹掉账本记录里已经删掉的字段。
 *
 * 账本是动态键映射，mergeDefaults 对它不做裁剪（fallback 没有键，一裁就会把
 * 整张表清空），所以「删掉一个字段」这件事只能在这里手工补一刀 —— 不管的话，
 * 存量记录里的旧字段会一直留着，还会被写回存储。
 *
 * 目前要抹的是 `status`：自动化流程（已跳过 / 已生成招呼语）的遗留字段，
 * 已从 JobRecord 中移除，界面上也不再有任何消费方。
 *
 * 导出是为了单测：这是迁移逻辑，出错时的症状（旧字段永远跟着存量数据）离原因很远。
 */
export function stripRemovedRecordFields(all: Record<string, JobRecord>): boolean {
  let changed = false
  for (const record of Object.values(all)) {
    const legacy = record as JobRecord & { status?: unknown }
    if (legacy.status === undefined)
      continue
    delete legacy.status
    changed = true
  }
  return changed
}

/**
 * 把所有存储键补上默认值，并把已有数据里缺失的字段补齐。
 *
 * 由 service worker 每次启动时调用，保证：
 *  1. 首次打开设置页不会显示空表单
 *  2. 旧数据（字符串格式 / 字段不全 / 换过格式）被就地迁移，用户不需要手动清存储
 *  3. useStoredValue 不需要「载入完成前不回写」的守卫
 *     —— 那个守卫会和 watch 抢时序，导致改动被静默丢弃
 *  4. 账本里已经删掉的字段（如 status）被抹掉，而不是永远跟着存量数据
 *
 * 迁移是幂等的：第二次运行会因为 JSON 完全一致而跳过写入。
 */
export async function ensureStorageDefaults(): Promise<void> {
  const keys = [KEY_AI, KEY_RESUME, KEY_MATCHING, KEY_RECORDS]

  let existing: Record<string, unknown>
  try {
    existing = await storage.local.get(keys)
  }
  catch (error) {
    console.error('[offer-hunter] 读取存储失败，跳过初始化', error)
    return
  }

  const patch: Record<string, unknown> = {}

  const ai = mergeDefaults(existing[KEY_AI], createDefaultAiSettings())
  if (JSON.stringify(ai) !== JSON.stringify(existing[KEY_AI]))
    patch[KEY_AI] = ai

  const resume = mergeDefaults(existing[KEY_RESUME], createEmptyResume())
  if (JSON.stringify(resume) !== JSON.stringify(existing[KEY_RESUME]))
    patch[KEY_RESUME] = resume

  const matching = mergeDefaults(existing[KEY_MATCHING], createDefaultMatchingSettings())
  if (JSON.stringify(matching) !== JSON.stringify(existing[KEY_MATCHING]))
    patch[KEY_MATCHING] = matching

  // 账本：既要兼容历史上被字符串化的数据，也要抹掉已删除的字段
  const recordsNeedWrite = existing[KEY_RECORDS] === undefined
    || existing[KEY_RECORDS] === null
    || typeof existing[KEY_RECORDS] === 'string'
  const records = mergeDefaults(existing[KEY_RECORDS], {}) as Record<string, JobRecord>
  if (recordsNeedWrite || stripRemovedRecordFields(records))
    patch[KEY_RECORDS] = records

  if (Object.keys(patch).length === 0)
    return

  try {
    await storage.local.set(patch)
  }
  catch (error) {
    console.error('[offer-hunter] 写入初始数据失败', error)
  }
}

/** 清空所有扩展数据（供设置页的「重置」使用） */
export async function resetAllStorage(): Promise<void> {
  await storage.local.remove([KEY_AI, KEY_RESUME, KEY_MATCHING, KEY_RECORDS])
  await ensureStorageDefaults()
}
