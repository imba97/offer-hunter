import type { SettingId } from '~/logic/store/settings'
import type { AiSettings, JobRecord, PromptSettings, Resume } from '~/logic/types'
import type { TxContext } from '~/platform/idb/database'
import { storage } from 'webextension-polyfill'
import { mergeDefaults, normalizeRecordLedger, normalizeResumeDoc } from '~/logic/store/migrations'
import { readRawSetting, writeSetting } from '~/logic/store/settings'
import { createDefaultAiSettings, createDefaultPromptSettings, createEmptyResume } from '~/logic/types'
import { clearStore, del, get, getAllEntries, put, putMany, runTx } from '~/platform/idb/database'

/**
 * TODO(过渡代码)：**整个模块都是过渡代码**，见 docs/transitional-code.md。
 *
 * 它存在的唯一理由是「让任何版本的存量数据都能安全搬进 IndexedDB」。
 * 确认不会再出现旧数据之后（通常一两个发布），本文件应当整体删除，同时要：
 *   - 摘掉 `ready.ts` 里的 `runMigration()` 调用；
 *   - 摘掉 `storage.ts` 的 `resetAllStorage` 里删旧键的兜底；
 *   - 从 `manifest.ts` 移除 `storage` 权限。
 *
 * 曾经这里还有「干跑预览 + 脱敏报告渲染」（供侧边栏那个临时 tab 用）。
 * 那个 tab 删掉之后，这一半在生产路径里已不可能被调用，只是每次迁移还要为它
 * 算一遍统计（多一趟全表遍历、三遍序列化、每条记录一个 TextEncoder）—— 已整体删除，
 * 需要时从 git 历史取回。迁移的**校验**没有跟着走：它靠 `computeChecksums`，
 * 那是真迁自己的一部分（见 `verifyMigration`）。
 */

/**
 * 旧存储（chrome.storage.local）的四个键名。
 *
 * **只出现在这个模块里** —— 迁移完成后它们就彻底退出代码。
 * 注意 `prompts` 的键名是 `offer-hunter-matching`：那是「打招呼规则」时代的名字，
 * 改键名会让存量用户写过的提示词读不到，所以一直沿用。
 */
export const STORAGE_KEYS = {
  ai: 'offer-hunter-ai',
  resume: 'offer-hunter-resume',
  prompts: 'offer-hunter-matching',
  records: 'offer-hunter-records',
} as const

// ---------------------------------------------------------------------------
// 摘要与稳定序列化
// ---------------------------------------------------------------------------

/**
 * 64 位 FNV-1a 摘要（16 位十六进制）。
 *
 * 刻意不用 `crypto.subtle`：它是异步的，会把整条迁移校验链路染成 async 且更难测；
 * 而这里要的只是「同样输入给同样输出」—— 用来发现**迁移过程中的意外改动**，
 * 不是抗碰撞的安全用途。跑两遍拼成 64 位而不是单个 32 位，理由与 `types.ts`
 * 里 jobIdentity 的摘要相同。
 *
 * ⚠ 不要与 `types.ts` 的 `contentDigest` 合并：那个摘要决定着**存量账本键**，
 *   一旦改动就会让老记录全部对不上；这个摘要只需要在「迁移前」与「迁移后」之间自洽。
 */
export function digest64(text: string): string {
  return `${fnv1a(text, 0x811C9DC5)}${fnv1a(text, 0x01000193)}`
}

function fnv1a(text: string, basis: number): string {
  let hash = basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 稳定序列化：对象键递归排序。
 *
 * 用途是算摘要，所以必须与「键的书写顺序」无关 —— 否则同一份数据经过
 * IndexedDB 的结构化克隆往返之后，只要键序变了摘要就会对不上，
 * 复核「无损」就变成了误报。
 */
export function stableJson(value: unknown): string {
  if (value === undefined)
    return 'undefined'
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value))
    return `[${value.map(stableJson).join(',')}]`

  const obj = value as Record<string, unknown>
  const body = Object.keys(obj)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
    .join(',')
  return `{${body}}`
}

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

export type LegacyKeyId = keyof typeof STORAGE_KEYS

/** 旧存储的快照：只带读出来的原始值（缺失即 undefined） */
export interface LegacySnapshot {
  values: Partial<Record<LegacyKeyId, unknown>>
}

export interface SettingPlan {
  id: LegacyKeyId
  value: unknown
}

export interface MigrationPlan {
  settings: SettingPlan[]
  /** 归一后的账本（键与字段都已迁好），真实迁移会逐条写入 */
  records: Record<string, JobRecord>
  counts: { records: number }
  /** 会与 counts 一起写进 meta.migration，供迁移后逐项复核 */
  checksums: Record<string, string>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * 计算「迁移后必须逐项一致」的摘要表。
 *
 * ⚠ **迁移前后必须调用同一个函数**：`runMigration` 用它算期望值、`verifyMigration`
 *   读回来重算并与期望比对。两边各算一套的话，「校验通过」就成了一句空话。
 *
 * 只给非空字段记摘要（空值不进表）：否则「本来就没有」会被当成一项待核对内容。
 */
export function computeChecksums(input: {
  ai: AiSettings
  resume: Resume
  prompts: PromptSettings
  records: Array<{ key: string, value: JobRecord }>
}): Record<string, string> {
  const out: Record<string, string> = {}

  if (input.ai.apiKey)
    out['ai.apiKey'] = digest64(input.ai.apiKey)
  if (input.ai.baseUrl)
    out['ai.baseUrl'] = digest64(input.ai.baseUrl)
  if (input.ai.model)
    out['ai.model'] = digest64(input.ai.model)

  if (input.prompts.matchPrompt)
    out['prompts.matchPrompt'] = digest64(input.prompts.matchPrompt)
  if (input.prompts.greetingPrompt)
    out['prompts.greetingPrompt'] = digest64(input.prompts.greetingPrompt)

  if (input.resume.markdown)
    out['resume.markdown'] = digest64(input.resume.markdown)
  const gist = asRecord(input.resume.sources.gist)
  for (const field of ['token', 'gistId', 'fileName'] as const) {
    const value = gist[field]
    if (typeof value === 'string' && value)
      out[`resume.sources.gist.${field}`] = digest64(value)
  }

  // 账本摘要：按键排序后拼接，键与值一起参与（只比内容不比身份的话，
  // 「记录被挂到别的岗位下」这类错配查不出来）
  out['records.digest'] = digest64(
    input.records
      .map(entry => `${entry.key}\u0000${stableJson(entry.value)}`)
      .sort()
      .join('\n'),
  )

  return out
}

/**
 * 把旧存储快照变成迁移计划。**纯函数**：不碰存储、不写任何东西，因此可单测。
 *
 * 三个设置文档的归一都用 `~/logic/store/migrations` 里那套现成函数，与门面
 * `readAiSettings` / `readResume` / `readPromptSettings` 完全一致 ——
 * 迁移写入的形状必须与日常读出来的形状是同一个。
 *
 * 这里也刻意**不做任何可能失败的校验**：所有可预见的失败都发生在开事务之前，
 * 事务里只放写（见 docs/indexeddb-migration.md §5.3）。
 */
export function planMigration(snapshot: LegacySnapshot): MigrationPlan {
  const ai = mergeDefaults(snapshot.values.ai, createDefaultAiSettings()) as AiSettings
  const resume = normalizeResumeDoc(snapshot.values.resume)
  const prompts = mergeDefaults(snapshot.values.prompts, createDefaultPromptSettings()) as PromptSettings
  const { value: records } = normalizeRecordLedger(snapshot.values.records)

  const settings: SettingPlan[] = [
    { id: 'ai', value: ai },
    { id: 'resume', value: resume },
    { id: 'prompts', value: prompts },
  ]

  return {
    settings,
    records,
    counts: { records: Object.keys(records).length },
    checksums: computeChecksums({
      ai,
      resume,
      prompts,
      records: Object.entries(records).map(([key, value]) => ({ key, value })),
    }),
  }
}

// ---------------------------------------------------------------------------
// 真实迁移
// ---------------------------------------------------------------------------

/** `meta` 仓库里的迁移标记键 */
const META_MIGRATION = 'migration'

export interface MigrationMeta {
  state: 'done'
  from: 'chrome.storage.local'
  at: string
  counts: { records: number }
  checksums: Record<string, string>
  /** 全新安装（旧键本来就没有内容） */
  fresh?: boolean
  /** 旧版本被装回来过：合并过一次 */
  conflictMergedAt?: string
}

export interface MigrationResult {
  status: 'migrated' | 'already-done' | 'fresh' | 'merged' | 'failed'
  counts?: { records: number }
  error?: string
}

/** 读旧存储的四个键（只取真实存在的，用于区分「不存在」与「存在但为 undefined」） */
async function readLegacyValues(): Promise<Partial<Record<LegacyKeyId, unknown>>> {
  const ids = Object.keys(STORAGE_KEYS) as LegacyKeyId[]
  const raw = await storage.local.get(ids.map(id => STORAGE_KEYS[id])) as Record<string, unknown>

  const values: Partial<Record<LegacyKeyId, unknown>> = {}
  for (const id of ids) {
    if (Object.hasOwn(raw, STORAGE_KEYS[id]))
      values[id] = raw[STORAGE_KEYS[id]]
  }
  return values
}

async function writeMigrationMeta(value: MigrationMeta, ctx?: TxContext): Promise<void> {
  await put('meta', { key: META_MIGRATION, value }, undefined, ctx)
}

async function readMigrationMeta(): Promise<MigrationMeta | null> {
  const doc = await get<{ key: string, value: MigrationMeta }>('meta', META_MIGRATION)
  return doc?.value ?? null
}

/**
 * 迁移后校验：把库里的东西读回来，用**同一个** `computeChecksums` 重算摘要对账。
 *
 * 这是「无损」的机器证据 —— 不靠人眼比对，也不依赖迁移过程的自述。
 */
async function verifyMigration(plan: MigrationPlan): Promise<{ ok: true } | { ok: false, reason: string }> {
  const entries = await getAllEntries<JobRecord>('records')
  if (entries.length !== plan.counts.records) {
    return {
      ok: false,
      reason: `记录条数不一致：库中 ${entries.length}，计划 ${plan.counts.records}`,
    }
  }

  const checksums = computeChecksums({
    ai: mergeDefaults(await readRawSetting('ai'), createDefaultAiSettings()) as AiSettings,
    resume: normalizeResumeDoc(await readRawSetting('resume')),
    prompts: mergeDefaults(await readRawSetting('prompts'), createDefaultPromptSettings()) as PromptSettings,
    records: entries.map(entry => ({ key: String(entry.key), value: entry.value })),
  })

  for (const [field, expected] of Object.entries(plan.checksums)) {
    if (checksums[field] !== expected) {
      return {
        ok: false,
        reason: `${field} 摘要不一致：期望 ${expected}，实际 ${checksums[field] ?? '(缺失)'}`,
      }
    }
  }

  return { ok: true }
}

/** 把一个计划写进库（一个事务：settings + records + meta） */
async function applyPlan(plan: MigrationPlan, meta: MigrationMeta): Promise<void> {
  const docs = new Map(plan.settings.map(setting => [setting.id, setting.value]))
  const entries = Object.entries(plan.records).map(([key, value]) => ({ key, value }))

  await runTx(['settings', 'records', 'meta'], 'readwrite', async (ctx) => {
    await writeSetting('ai', docs.get('ai'), ctx)
    await writeSetting('resume', docs.get('resume'), ctx)
    await writeSetting('prompts', docs.get('prompts'), ctx)
    // 全新库本来是空的；清一次是为了让「重试」也不会留下上一轮的残留
    await clearStore('records', ctx)
    await putMany('records', entries, ctx)
    await writeMigrationMeta(meta, ctx)
  })
}

/**
 * 旧版本被装回来过：IDB 已经是 done，但 `chrome.storage.local` 又有内容了。
 *
 * 规则（与方案 §7.4 一致，刻意简单可预期）：
 *   - 记录**按键取并集**，冲突时以 IDB 为准（IDB 里的更可能是刚用过的）；
 *   - 设置：IDB 里的值等于默认值才由旧键接管；
 *   - 记一条 `conflictMergedAt` 便于排障。
 */
async function mergeLegacyAfterDowngrade(values: Partial<Record<LegacyKeyId, unknown>>, previous: MigrationMeta): Promise<MigrationResult> {
  const plan = planMigration({ values })
  const existingKeys = new Set((await getAllEntries<JobRecord>('records')).map(entry => String(entry.key)))
  const additions = Object.entries(plan.records)
    .filter(([key]) => !existingKeys.has(key))
    .map(([key, value]) => ({ key, value }))

  const docs = new Map(plan.settings.map(setting => [setting.id, setting.value]))

  /*
   * ⚠ 判据必须放在**开事务之前**：事务里读取会自己开一个新事务，外层 readwrite 事务
   *    随即失活，紧接着带 `ctx` 的写就抛 InvalidStateError（§5.3 那条规矩，由
   *    runMigration 的单测抓出来的）。
   *
   * ⚠ 判据的**两边都要过同一个归一化**，否则「是否仍是默认值」这句话是假的：
   *    简历的默认值是 `sources: {}`，而任何写进库的简历都被 `ensureSourceConfigs`
   *    填成了 `{gist, paste}` —— 拿未归一的默认值去比，**永远不相等**，
   *    于是旧版本期间新建的简历永远不被接管，紧接着旧键就被删掉 = 静默丢失。
   *    （真机级后果，评审用「prompts 有测试、resume 没有」这个不对称发现的。）
   */
  const defaults: Record<SettingId, object> = {
    ai: createDefaultAiSettings(),
    resume: createEmptyResume(),
    prompts: createDefaultPromptSettings(),
  }

  /** 按 id 归一成「库里实际会长的样子」——与门面读出来的一致 */
  const effective = (id: SettingId, raw: unknown): object =>
    id === 'resume' ? normalizeResumeDoc(raw) : mergeDefaults(raw, defaults[id])

  // 用 stableJson 而不是 JSON.stringify：这个比较不该受键序影响
  const defaultDigest = (id: SettingId): string => stableJson(effective(id, defaults[id]))

  const takeover: SettingId[] = []
  for (const id of ['ai', 'resume', 'prompts'] as const) {
    const current = await readRawSetting(id)
    const isDefault = current === undefined
      || stableJson(effective(id, current)) === defaultDigest(id)
    if (isDefault)
      takeover.push(id)
  }

  await runTx(['settings', 'records', 'meta'], 'readwrite', async (ctx) => {
    for (const id of takeover)
      await writeSetting(id, docs.get(id), ctx)
    if (additions.length)
      await putMany('records', additions, ctx)
    await writeMigrationMeta({ ...previous, conflictMergedAt: new Date().toISOString() }, ctx)
  })

  await storage.local.remove(Object.values(STORAGE_KEYS))
  console.warn(`[offer-hunter] 检测到旧版本写入的数据，已合并 ${additions.length} 条记录`)
  return { status: 'merged', counts: { records: additions.length } }
}

/**
 * 执行迁移（**幂等、原子、可重试**）。
 *
 * 顺序（每一步都不能换个位置）：
 *  1. 读迁移标记：已完成且旧键没有新内容 → 直接返回；
 *  2. 读旧键：四个都没有 → 全新安装，只写标记；
 *  3. `planMigration` 产出计划（**纯函数，所有可预见的失败都在这一步之前发生**）；
 *  4. 一个事务写入 settings + records + meta（标记也在事务里 → 不存在「搬一半却标了完成」）；
 *  5. 读回来重算摘要对账；
 *  6. **只有对账通过才删旧键** —— 旧键是唯一的回退依据。
 *
 * 任何一步失败都不动旧键，并把迁移标记清掉，下次启动重来。
 */
export async function runMigration(): Promise<MigrationResult> {
  const previous = await readMigrationMeta()
  const values = await readLegacyValues()
  const hasLegacy = Object.keys(values).length > 0

  if (previous?.state === 'done') {
    if (!hasLegacy)
      return { status: 'already-done' }
    return mergeLegacyAfterDowngrade(values, previous)
  }

  const now = new Date().toISOString()

  if (!hasLegacy) {
    // 全新安装：只落一个标记，免得每次启动都去读一遍旧键
    await writeMigrationMeta({
      state: 'done',
      from: 'chrome.storage.local',
      at: now,
      counts: { records: 0 },
      checksums: {},
      fresh: true,
    })
    return { status: 'fresh' }
  }

  const plan = planMigration({ values })
  const meta: MigrationMeta = {
    state: 'done',
    from: 'chrome.storage.local',
    at: now,
    counts: plan.counts,
    checksums: plan.checksums,
  }

  try {
    await applyPlan(plan, meta)
  }
  catch (error) {
    return { status: 'failed', error: `写入失败：${errorText(error)}` }
  }

  const verified = await verifyMigration(plan)
  if (!verified.ok) {
    // 标记要撤掉，否则下次会以为已经迁完而跳过 —— 那才是真正会造成数据缺失的路径
    await del('meta', META_MIGRATION).catch(() => {})
    return { status: 'failed', error: `校验未通过：${verified.reason}（旧数据已保留，下次启动会重试）` }
  }

  await storage.local.remove(Object.values(STORAGE_KEYS))
  return { status: 'migrated', counts: plan.counts }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
