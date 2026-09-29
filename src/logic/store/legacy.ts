/**
 * TODO(过渡代码)：**整个模块都是过渡代码**，见 docs/transitional-code.md。
 *
 * 它存在的唯一理由是「让任何版本的存量数据都能安全搬进 IndexedDB」。
 * 确认不会再出现旧数据之后（通常一两个发布），本文件应当整体删除：
 *   - 第一批可删：`previewMigration` / `renderMigrationReport` / `exportLegacySnapshot`
 *     （临时预览 tab 已删，这些已无生产调用方）；
 *   - 第二批：`runMigration` 及其依赖，同时要摘掉 `ready.ts` 的调用、
 *     `storage.ts` 里删旧键的兜底、以及 `manifest.ts` 的 `storage` 权限。
 */

import type { SettingId } from '~/logic/store/settings'
import type { AiSettings, JobRecord, PromptSettings, Resume } from '~/logic/types'
import type { TxContext } from '~/platform/idb/database'
import { runtime, storage } from 'webextension-polyfill'
import { mergeDefaults, normalizeRecordLedger, normalizeResumeDoc, reviveLegacyString } from '~/logic/store/migrations'
import { readRawSetting, writeSetting } from '~/logic/store/settings'
import { createDefaultAiSettings, createDefaultPromptSettings, createEmptyResume, JOB_RECORD_FIELDS } from '~/logic/types'
import { clearStore, del, get, getAllEntries, put, putMany, runTx } from '~/platform/idb/database'

/**
 * 旧存储（chrome.storage.local）的四个键名。
 *
 * **只出现在这个模块里** —— 迁移完成后它们就彻底退出代码。
 * 注意 `prompts` 的键名是 `offer-hunter-matching`：那是「打招呼规则」时代的名字，
 * 改键名会让存量用户写过的提示词读不到，所以一直沿用（见 storage.ts 旧注释）。
 */
export const STORAGE_KEYS = {
  ai: 'offer-hunter-ai',
  resume: 'offer-hunter-resume',
  prompts: 'offer-hunter-matching',
  records: 'offer-hunter-records',
} as const

/**
 * 旧存储（chrome.storage.local）→ IndexedDB 的迁移逻辑。
 *
 * 结构上分两块，**共用同一个 `planMigration`**：干跑预览渲染计划，真实迁移执行计划。
 * 这是整个设计的要点 —— 转换逻辑只有一份，各写一份的话「预览通过、迁移却不一样」
 * 只是时间问题（调用链见 docs/indexeddb-migration.md §7.1）。
 *
 * ⚠ 报告会被用户复制粘贴给开发者看，因此**脱敏在这一层完成**（不是靠用户手动删）：
 *   简历原文、API Key、Gist token、token 之外的 job 字段值一律不出现，
 *   只给「是否存在 / 长度 / 摘要」。摘要的作用是迁移后逐项复核「无损」——
 *   哈希一致即内容一致，双方都不需要看到原文。
 */

// ---------------------------------------------------------------------------
// 摘要与稳定序列化
// ---------------------------------------------------------------------------

/**
 * 64 位 FNV-1a 摘要（16 位十六进制）。
 *
 * 刻意不用 `crypto.subtle`：它是异步的，会把整条预览链路染成 async 且更难测；
 * 而这里要的只是「同样输入给同样输出」—— 用来发现**迁移过程中的意外改动**，
 * 不是抗碰撞的安全用途。跑两遍拼成 64 位而不是单个 32 位，理由与
 * `types.ts` 里 jobIdentity 的摘要相同（千条量级下 32 位的撞车概率已不可忽略）。
 *
 * ⚠ 不要与 `types.ts` 的 `contentDigest` 合并：那个摘要决定着**存量账本键**，
 *   一旦改动就会让老记录全部对不上；这个摘要只需要在「预览」与「迁移」之间自洽，
 *   将来要换算法是自由的。两者用途不同，共用一个函数反而是隐患。
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

/** 旧存储的快照：读出来的原始值 + 各键占用字节数 */
export interface LegacySnapshot {
  values: Partial<Record<LegacyKeyId, unknown>>
  bytes?: Partial<Record<LegacyKeyId, number>>
}

export interface LegacyKeyInfo {
  id: LegacyKeyId
  key: string
  present: boolean
  /** 人类可读的原始类型，例如 `object` / `字符串(JSON)` / `字符串` / `null` */
  kind: string
  bytes: number | null
}

export interface SettingPlan {
  id: LegacyKeyId
  value: unknown
  /** 人话说明这次归一做了什么（供报告展示，也供人核对） */
  notes: string[]
  /** 需要逐项复核的字段摘要：字段路径 → 摘要 */
  checksums: Record<string, string>
}

/**
 * 重构前那套「接口原名」字段：看到它们说明这条记录来自旧版本。
 *
 * 与 `storage.ts` 里归一化用的映射表是同一份知识，但**刻意各写一遍**：
 * 那边决定「怎么迁」，这边只负责「怎么报」，两者用途不同 ——
 * 报告必须能说出「哪些字段是旧的」，哪怕将来迁移策略改了。
 */
const LEGACY_WIRE_FIELDS = ['jobName', 'brandName', 'bossName', 'salaryDesc'] as const

export interface RecordStats {
  /** 原始条数（归一前） */
  total: number
  /** 非对象条目：会被丢弃 */
  nonObject: number
  /** 键里没有 `:`：会被改成 `<siteId>:<naturalKey>` */
  needsKeyMigration: number
  hasSecurityId: number
  hasStatus: number
  bySiteId: Record<string, number>
  firstSeen: { min: string, max: string } | null
  withMatch: number
  withGreeting: number
  withError: number
  /** 原始账本的 JSON 字节数 */
  jsonBytes: number
  maxRecordBytes: number
  minRecordBytes: number
  /**
   * 整本账本的字段直方图：字段名 → 含该字段的记录数。
   *
   * 只给**字段名与计数，不给值** —— 但正是它暴露出「这本账本其实有两种形状」，
   * 而只看首条记录是看不出来的（第一次干跑就吃了这个亏）。
   */
  fieldCounts: Record<string, number>
  /** 含当前模型字段 `title` 的记录数 */
  newShape: number
  /** 含接口原名（jobName / brandName / …）的记录数 */
  legacyWireShape: number
  /** 同时含新旧两套字段名的记录数 */
  mixedShape: number
  /** 含 `jdText`（当前模型不保存 JD 原文）的记录数 */
  withJdText: number
  /** 含站点私有 id（encryptJobId / encryptBossId）的记录数 */
  withSiteIds: number
  /** 出现在记录里、但当前模型不认识的字段名（排序去重） */
  unknownFields: string[]
  /** 至少含一个未知字段的记录数（迁移会把这些字段丢掉） */
  withUnknownFields: number
  /** `match` 已损坏（缺 reasons / missingSkills 数组）的记录数：归一化会兜住，但要说出来 */
  brokenMatches: number
}

export interface MigrationPlan {
  settings: SettingPlan[]
  /** 归一后的账本（键与字段都已迁好），真实迁移会逐条写入 */
  records: Record<string, JobRecord>
  recordStats: RecordStats
  legacyKeys: LegacyKeyInfo[]
  counts: { records: number }
  /** 汇总摘要，将来会与 counts 一起写进 meta.migration */
  checksums: Record<string, string>
}

/** 原始类型的人话描述 */
function describeKind(value: unknown): string {
  if (value === undefined)
    return '缺失'
  if (value === null)
    return 'null'
  if (typeof value === 'string') {
    return value.trim().startsWith('{') || value.trim().startsWith('[')
      ? '字符串(JSON)'
      : '字符串'
  }
  if (Array.isArray(value))
    return '数组'
  return typeof value
}

function plainKeys(value: unknown): string[] {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : []
}

/** 比较「原始（已复活）」与「归一后」的顶层字段，得出被裁掉与被补上的字段名 */
function diffKeys(before: unknown, after: unknown): { pruned: string[], filled: string[] } {
  const b = plainKeys(before)
  const a = plainKeys(after)
  return {
    pruned: b.filter(key => !a.includes(key)),
    filled: a.filter(key => !b.includes(key)),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** 字节数：中文一个字符 3 字节，用 `length` 会大幅低估 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function collectRecordStats(rawMap: Record<string, unknown>): RecordStats {
  const keys = Object.keys(rawMap)
  const bySiteId: Record<string, number> = {}
  const fieldCounts: Record<string, number> = {}
  let nonObject = 0
  let needsKeyMigration = 0
  let hasSecurityId = 0
  let hasStatus = 0
  let withMatch = 0
  let withGreeting = 0
  let withError = 0
  let newShape = 0
  let legacyWireShape = 0
  let mixedShape = 0
  let withJdText = 0
  let withSiteIds = 0
  let brokenMatches = 0
  let min = ''
  let max = ''
  let maxBytes = 0
  let minBytes = Number.POSITIVE_INFINITY

  for (const key of keys) {
    const record = rawMap[key]
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      nonObject++
      continue
    }

    const obj = record as Record<string, unknown>
    if (!key.includes(':'))
      needsKeyMigration++
    if (obj.securityId !== undefined)
      hasSecurityId++
    if (obj.status !== undefined)
      hasStatus++
    if (obj.match)
      withMatch++
    if (obj.greeting)
      withGreeting++
    if (obj.error)
      withError++

    const isNew = obj.title !== undefined
    const isLegacy = LEGACY_WIRE_FIELDS.some(field => obj[field] !== undefined)
    if (isNew)
      newShape++
    if (isLegacy)
      legacyWireShape++
    if (isNew && isLegacy)
      mixedShape++
    if (obj.jdText !== undefined)
      withJdText++
    if (obj.encryptJobId !== undefined || obj.encryptBossId !== undefined)
      withSiteIds++

    if (obj.match !== null && obj.match !== undefined && typeof obj.match === 'object') {
      const match = obj.match as Record<string, unknown>
      if (!Array.isArray(match.reasons) || !Array.isArray(match.missingSkills))
        brokenMatches++
    }

    for (const field of Object.keys(obj))
      fieldCounts[field] = (fieldCounts[field] ?? 0) + 1

    const siteId = typeof obj.siteId === 'string' && obj.siteId ? obj.siteId : '(无)'
    bySiteId[siteId] = (bySiteId[siteId] ?? 0) + 1

    const seen = typeof obj.firstSeen === 'string' ? obj.firstSeen : ''
    if (seen) {
      if (!min || seen < min)
        min = seen
      if (!max || seen > max)
        max = seen
    }

    const bytes = byteLength(stableJson(obj))
    if (bytes > maxBytes)
      maxBytes = bytes
    if (bytes < minBytes)
      minBytes = bytes
  }

  const known = new Set<string>(Object.keys(JOB_RECORD_FIELDS))
  const unknownFields = Object.keys(fieldCounts)
    .filter(field => !known.has(field))
    .sort()

  return {
    total: keys.length,
    nonObject,
    needsKeyMigration,
    hasSecurityId,
    hasStatus,
    bySiteId,
    firstSeen: min ? { min, max } : null,
    withMatch,
    withGreeting,
    withError,
    jsonBytes: byteLength(stableJson(rawMap)),
    maxRecordBytes: maxBytes,
    minRecordBytes: Number.isFinite(minBytes) ? minBytes : 0,
    fieldCounts,
    newShape,
    legacyWireShape,
    mixedShape,
    withJdText,
    withSiteIds,
    unknownFields,
    withUnknownFields: keys.filter((key) => {
      const record = rawMap[key]
      if (record === null || typeof record !== 'object' || Array.isArray(record))
        return false
      return Object.keys(record).some(field => !known.has(field))
    }).length,
    brokenMatches,
  }
}

/**
 * 计算「迁移后必须逐项一致」的摘要表。
 *
 * ⚠ **预览与真实迁移必须调用同一个函数**：干跑渲染的是它、迁移校验读回来的
 *   也是它。两边各算一套的话，"校验通过"就成了一句空话。
 *
 * 只给非空字段记摘要（空值不进表）：否则「本来就没有」会被当成一项待核对内容，
 * 报告里多出一堆无意义的行。
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
 * 三个设置文档的归一都用 `~/logic/store/migrations` 里那套现成函数，与启动时的
 * 归一完全一致 —— 预览要能代表真实迁移，就不能另起一套。
 */
export function planMigration(snapshot: LegacySnapshot): MigrationPlan {
  const rawAi = snapshot.values.ai
  const rawResume = snapshot.values.resume
  const rawPrompts = snapshot.values.prompts
  const rawRecords = snapshot.values.records

  // --- ai ---------------------------------------------------------------
  const ai = mergeDefaults(rawAi, createDefaultAiSettings()) as AiSettings
  const aiDiff = diffKeys(reviveLegacyString(rawAi), ai)
  const aiNotes = describeSettingsNotes(rawAi, aiDiff)

  // --- prompts ----------------------------------------------------------
  const prompts = mergeDefaults(rawPrompts, createDefaultPromptSettings()) as PromptSettings
  const promptsDiff = diffKeys(reviveLegacyString(rawPrompts), prompts)
  const promptsNotes = describeSettingsNotes(rawPrompts, promptsDiff)

  // --- resume -----------------------------------------------------------
  const revivedResume = reviveLegacyString(rawResume)
  const resume = normalizeResumeDoc(rawResume)
  const resumeDiff = diffKeys(revivedResume, resume)
  const revivedObj = asRecord(revivedResume)

  /*
   * `gist` / `syncedFrom` 是被 migrateResumeShape **有意改名**的，不算「被裁掉的
   * 字段」—— 混在 pruned 里会让人以为丢了东西。它们单独报。
   */
  const resumeNotes: string[] = []
  if (typeof rawResume === 'string')
    resumeNotes.push('原始值是 JSON 字符串，已复活为对象')
  if (revivedObj.gist !== undefined)
    resumeNotes.push('legacy 字段 gist → sources.gist')
  if (revivedObj.syncedFrom !== undefined)
    resumeNotes.push('legacy 字段 syncedFrom → syncedKey')
  const resumePruned = resumeDiff.pruned.filter(key => key !== 'gist' && key !== 'syncedFrom')
  if (resumePruned.length)
    resumeNotes.push(`裁掉字段 ${resumePruned.join('、')}`)
  if (resumeDiff.filled.length)
    resumeNotes.push(`补上字段 ${resumeDiff.filled.join('、')}`)

  const rawSources = asRecord(revivedObj.sources)
  const addedSources = Object.keys(resume.sources)
    .filter(id => rawSources[id] === undefined)
  if (addedSources.length)
    resumeNotes.push(`补出来源配置 ${addedSources.join('、')}`)

  const filledSourceFields: string[] = []
  for (const [id, config] of Object.entries(resume.sources)) {
    const before = asRecord(rawSources[id] ?? revivedObj[id])
    const filled = Object.keys(config).filter(field => before[field] === undefined)
    if (filled.length)
      filledSourceFields.push(`${id}: ${filled.join('、')}`)
  }
  if (filledSourceFields.length)
    resumeNotes.push(`来源内补字段 ${filledSourceFields.join('；')}`)
  if (!resumeNotes.length)
    resumeNotes.push('无需改动')

  // --- records ----------------------------------------------------------
  const rawRecordsRevived = reviveLegacyString(rawRecords)
  const rawMap = asRecord(rawRecordsRevived)
  const recordStats = collectRecordStats(rawMap)
  const { value: records } = normalizeRecordLedger(rawRecords)
  const recordEntries = Object.entries(records).map(([key, value]) => ({ key, value }))

  // 摘要表由 computeChecksums 统一算 —— 迁移后的校验读回来也走同一个函数
  const checksums = computeChecksums({ ai, resume, prompts, records: recordEntries })
  const checksumsFor = (prefix: string) =>
    Object.fromEntries(Object.entries(checksums).filter(([field]) => field.startsWith(prefix)))

  const settings: SettingPlan[] = [
    { id: 'ai', value: ai, notes: aiNotes, checksums: checksumsFor('ai.') },
    { id: 'resume', value: resume, notes: resumeNotes, checksums: checksumsFor('resume.') },
    { id: 'prompts', value: prompts, notes: promptsNotes, checksums: checksumsFor('prompts.') },
  ]
  const legacyKeys: LegacyKeyInfo[] = (Object.keys(STORAGE_KEYS) as LegacyKeyId[]).map((id) => {
    const value = snapshot.values[id]
    return {
      id,
      key: STORAGE_KEYS[id],
      present: value !== undefined,
      kind: describeKind(value),
      bytes: snapshot.bytes?.[id] ?? null,
    }
  })

  return {
    settings,
    records,
    recordStats,
    legacyKeys,
    counts: { records: recordEntries.length },
    checksums,
  }
}

function describeSettingsNotes(raw: unknown, diff: { pruned: string[], filled: string[] }): string[] {
  const notes: string[] = []
  if (typeof raw === 'string')
    notes.push('原始值是 JSON 字符串，已复活为对象')
  if (raw === undefined)
    notes.push('键不存在，写入默认值')
  if (diff.pruned.length)
    notes.push(`裁掉字段 ${diff.pruned.join('、')}`)
  if (diff.filled.length)
    notes.push(`补上字段 ${diff.filled.join('、')}`)
  if (!notes.length)
    notes.push('无需改动')
  return notes
}

// ---------------------------------------------------------------------------
// 真实迁移（阶段 C）
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

/**
 * 读旧存储的四个键（只取真实存在的，用于区分「不存在」与「存在但为 undefined」）。
 */
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
async function applyPlan(plan: MigrationPlan, meta: MigrationMeta | ((at: string) => MigrationMeta)): Promise<void> {
  const docs = new Map(plan.settings.map(setting => [setting.id, setting.value]))
  const entries = Object.entries(plan.records).map(([key, value]) => ({ key, value }))

  await runTx(['settings', 'records', 'meta'], 'readwrite', async (ctx) => {
    await writeSetting('ai', docs.get('ai'), ctx)
    await writeSetting('resume', docs.get('resume'), ctx)
    await writeSetting('prompts', docs.get('prompts'), ctx)
    // 全新库本来是空的；清一次是为了让「重试」也不会留下上一轮的残留
    await clearStore('records', ctx)
    await putMany('records', entries, ctx)
    await writeMigrationMeta(typeof meta === 'function' ? meta(new Date().toISOString()) : meta, ctx)
  })
}

/**
 * 旧版本被装回来过：IDB 已经是 done，但 `chrome.storage.local` 又有内容了。
 *
 * 规则（与方案 §7.3 一致，刻意简单可预期）：
 *   - 记录**按键取并集**，冲突时以 IDB 为准（IDB 里的更可能是刚用过的）；
 *   - 设置：IDB 里没有该文档才用旧键的（有内容就以 IDB 为准）；
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
   * ⚠ 两件事都必须放在**开事务之前**：
   *
   * 1. 判断「哪些设置还该由旧键接管」。判据是**内容等于默认值**，不是「文档不存在」——
   *    首次迁移会把三个默认文档都写进库，若按「存在即保留」，用户在旧版本期间
   *    写的提示词就永远进不来了。这条差异是被 runMigration 的单测抓出来的。
   * 2. 读取本身不能在事务里做：那会自己开一个新事务，外层 readwrite 事务随即失活，
   *    紧接着带 `ctx` 的写就抛 InvalidStateError（§5.3 那条规矩）。
   */
  const defaults: Record<SettingId, object> = {
    ai: createDefaultAiSettings(),
    resume: createEmptyResume(),
    prompts: createDefaultPromptSettings(),
  }
  const takeover: SettingId[] = []
  for (const id of ['ai', 'resume', 'prompts'] as const) {
    const current = await readRawSetting(id)
    const isDefault = current === undefined
      || JSON.stringify(mergeDefaults(current, defaults[id])) === JSON.stringify(defaults[id])
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

// ---------------------------------------------------------------------------
// 报告渲染
// ---------------------------------------------------------------------------

export interface PreviewEnvironment {
  at: string
  version: string
  where: string
  extensionId: string
  /** null = 该环境没有 `indexedDB.databases()`，无法检测已有库 */
  idbDatabases: string[] | null
  estimate: { usage: number | null, quota: number | null } | null
}

/** 「非空，长度 N，摘要 xxxx」——报告里所有敏感值的统一呈现方式 */
function describeSecret(value: unknown): string {
  if (typeof value !== 'string' || !value)
    return '(空)'
  return `非空 长度 ${value.length} 摘要 ${digest64(value)}`
}

/**
 * 字段直方图排版：每行 4 个「字段:计数」，按计数降序。
 *
 * 排成多行是因为字段可能有几十个，挤在一行里报告就没法读了 ——
 * 而这份直方图恰恰是最需要一眼看清的部分。
 */
function formatFieldCounts(counts: Record<string, number>): string[] {
  const entries = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([field, count]) => `${field}:${count}`)

  const lines: string[] = []
  for (let i = 0; i < entries.length; i += 4)
    lines.push(entries.slice(i, i + 4).join('   '))
  return lines.length ? lines : ['(无)']
}

function fmtBytes(bytes: number | null): string {
  if (bytes === null)
    return '未知'
  if (bytes < 1024)
    return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/** 取某个设置的计划；planMigration 必定产出三者，缺了就是内部不一致 */
function settingOf(plan: MigrationPlan, id: LegacyKeyId): SettingPlan {
  const found = plan.settings.find(setting => setting.id === id)
  if (!found)
    throw new Error(`迁移计划缺少设置项：${id}`)
  return found
}

/**
 * 渲染脱敏报告。
 *
 * **这里决定了用户会粘贴出去的内容**，所以规则是「默认什么都不给」：
 * 只呈现结构、计数、长度与摘要。要新增字段时先问一句「这一行会不会泄露
 * 用户内容」，会就别加。
 */
export function renderMigrationReport(plan: MigrationPlan, env: PreviewEnvironment): string {
  const lines: string[] = []
  const push = (...text: string[]) => lines.push(...text)

  push(
    '=== Offer Hunter 迁移干跑报告（只读，未写入任何数据）===',
    `时间 ${env.at}   版本 ${env.version}   运行位置 ${env.where}`,
    `扩展 ID ${env.extensionId}`,
    '',
  )

  if (plan.legacyKeys.every(k => !k.present)) {
    push(
      '⚠ 四个旧键全都不存在。若你确信本机有数据，说明当前扩展实例不是持有数据的那一个',
      '   （chrome.storage.local 按扩展 ID 隔离：商店安装与本地构建的 ID 不同）。',
      '',
    )
  }

  const dbs = env.idbDatabases === null
    ? '无法检测（该环境没有 indexedDB.databases()）'
    : (env.idbDatabases.length ? JSON.stringify(env.idbDatabases) : '[]（尚无）')
  push(`[环境] IndexedDB 已有库 ${dbs}`)
  if (env.estimate) {
    push(`       存储用量 ${fmtBytes(env.estimate.usage)} / 配额 ${fmtBytes(env.estimate.quota)}`)
  }
  push('')

  push('[旧键概览]')
  for (const info of plan.legacyKeys) {
    push(`  ${info.key.padEnd(22)} ${info.present ? '存在' : '不存在'}  ${info.present ? info.kind : ''}  ${info.present ? fmtBytes(info.bytes) : ''}`.trimEnd())
  }
  push('')

  push('[ai]')
  const ai = settingOf(plan, 'ai')
  const aiValue = ai.value as AiSettings
  push(`  platform ${JSON.stringify(aiValue.platform)}   model ${aiValue.model ? JSON.stringify(aiValue.model) : '(空)'}`)
  push(`  baseUrl ${aiValue.baseUrl ? `已配置（长度 ${aiValue.baseUrl.length}，摘要 ${digest64(aiValue.baseUrl)}）` : '(空，用平台默认)'}`)
  push(`  apiKey ${describeSecret(aiValue.apiKey)}   maxTokens ${aiValue.maxTokens}`)
  push(`  归一化 ${ai.notes.join('；')}`)
  push('')

  push('[resume]')
  const resumePlan = settingOf(plan, 'resume')
  const resumeValue = resumePlan.value as Resume
  push(`  markdown ${resumeValue.markdown ? `非空 长度 ${resumeValue.markdown.length} 行数 ${resumeValue.markdown.split('\n').length} 摘要 ${digest64(resumeValue.markdown)}` : '(空)'}`)
  push(`  sourceId ${JSON.stringify(resumeValue.sourceId)}   syncedAt ${resumeValue.syncedAt ?? 'null'}   syncedKey ${resumeValue.syncedKey ? '有' : '无'}`)
  push(`  来源配置 ${Object.keys(resumeValue.sources).join('、') || '(无)'}`)
  const gistConfig = asRecord(resumeValue.sources.gist)
  if (Object.keys(gistConfig).length) {
    push(`    gist.gistId ${describeSecret(gistConfig.gistId)}`)
    push(`    gist.fileName ${gistConfig.fileName ? JSON.stringify(gistConfig.fileName) : '(空)'}`)
    push(`    gist.token ${describeSecret(gistConfig.token)}`)
  }
  push(`  归一化 ${resumePlan.notes.join('；')}`)
  push('')

  push('[prompts]')
  const promptsPlan = settingOf(plan, 'prompts')
  const promptsValue = promptsPlan.value as PromptSettings
  push(`  matchPrompt ${describeSecret(promptsValue.matchPrompt)}`)
  push(`  greetingPrompt ${describeSecret(promptsValue.greetingPrompt)}`)
  push(`  归一化 ${promptsPlan.notes.join('；')}`)
  push('')

  const s = plan.recordStats
  push('[records]')
  push(`  条数 ${s.total}   非对象条目 ${s.nonObject}（会被丢弃）   键不含':' ${s.needsKeyMigration}（会改成 站点:标识）`)
  push(`  含 legacy securityId ${s.hasSecurityId}   含 legacy status ${s.hasStatus}`)
  push(`  siteId 分布 ${JSON.stringify(s.bySiteId)}`)
  push(`  firstSeen ${s.firstSeen ? `${s.firstSeen.min} … ${s.firstSeen.max}` : '(无)'}`)
  push(`  有 match ${s.withMatch}   有 greeting ${s.withGreeting}   有 error ${s.withError}`)
  push(`  JSON 体积 ${fmtBytes(s.jsonBytes)}   单条最大 ${fmtBytes(s.maxRecordBytes)}   单条最小 ${fmtBytes(s.minRecordBytes)}`)
  push('')
  push('  [记录形状]')
  push(`    含新字段名 title ${s.newShape}   含旧接口字段名 ${s.legacyWireShape}   新旧都有 ${s.mixedShape}`)
  push(`    含 jdText ${s.withJdText}   含站点私有 id ${s.withSiteIds}`)
  push(`    未知字段（当前模型不认识）${s.unknownFields.length ? s.unknownFields.join('、') : '无'}`)
  push(`    含未知字段的记录 ${s.withUnknownFields} 条（迁移时这些字段会被丢弃）`)
  push(`    match 形状损坏（缺 reasons/missingSkills）${s.brokenMatches} 条${s.brokenMatches ? '（归一化会补齐空数组）' : ''}`)
  push('  [字段分布·出现该字段的记录数]')
  for (const line of formatFieldCounts(s.fieldCounts))
    push(`    ${line}`)
  push('')

  push('[迁移预演·不写入]')
  push(`  将写入 settings：${plan.settings.map(x => x.id).join('、')}`)
  push(`  将写入 records：${plan.counts.records} 条（原始 ${s.total} 条）`)
  push(`  meta.migration.counts ${JSON.stringify(plan.counts)}`)
  push('  事务 1 个 readwrite（settings + records + meta）   校验通过后删除旧键')
  push('')

  push('[校验摘要·迁移后必须逐项一致]')
  for (const [field, digest] of Object.entries(plan.checksums))
    push(`  ${field.padEnd(28)} ${digest}`)

  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// 只读取数
// ---------------------------------------------------------------------------

/**
 * 干跑入口：**只读**。
 *
 * 三条只读纪律（改这个函数时请一并守住）：
 *  1. 只调 `storage.local.get` / `getBytesInUse`，以及纯函数。
 *  2. 不写任何键。
 *  3. 检测 IndexedDB 用 `indexedDB.databases()`（只列不打开）——
 *     `open()` 会在库不存在时把它**创建**出来，那就不是只读了。
 */
export async function previewMigration(): Promise<{ plan: MigrationPlan, report: string }> {
  const ids = Object.keys(STORAGE_KEYS) as LegacyKeyId[]
  const keys = ids.map(id => STORAGE_KEYS[id])

  const raw = await storage.local.get(keys) as Record<string, unknown>
  const values: Partial<Record<LegacyKeyId, unknown>> = {}
  for (const id of ids) {
    // get 只返回存在的键，用 hasOwn 区分「不存在」与「存在但为 undefined」
    if (Object.hasOwn(raw, STORAGE_KEYS[id]))
      values[id] = raw[STORAGE_KEYS[id]]
  }

  const bytes: Partial<Record<LegacyKeyId, number>> = {}
  for (const id of ids) {
    try {
      const size = await storage.local.getBytesInUse?.(STORAGE_KEYS[id])
      if (typeof size === 'number')
        bytes[id] = size
    }
    catch {
      // 拿不到就不显示，不影响其余部分
    }
  }

  const plan = planMigration({ values, bytes })
  return { plan, report: renderMigrationReport(plan, await readEnvironment()) }
}

/**
 * 导出四个旧键的**原始值**（迁移前的人工备份）。
 *
 * ⚠ 与干跑报告**相反**：这里是未脱敏的 —— 简历原文、API Key、Gist token 全在里面。
 *   它的用途是「万一迁移出问题，本机还留着一份原始数据可以回头看」，
 *   因此只在用户主动点击时执行，且**不经过任何服务器**（浏览器直接下载文件）。
 *
 * 有这个备份，决策 F2（归一化时丢掉旧字段）才是可回退的。
 */
export async function exportLegacySnapshot(): Promise<string> {
  const values = await storage.local.get(Object.values(STORAGE_KEYS)) as Record<string, unknown>

  let extensionId = '(未知)'
  let version: string | null = null
  try {
    extensionId = runtime.id
    version = runtime.getManifest?.().version ?? null
  }
  catch {
    // 非扩展环境下保持未知
  }

  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    extensionId,
    version,
    note: 'Offer Hunter 迁移前的原始存储快照（未脱敏，含简历与密钥，请勿外传）',
    keys: values,
  }, null, 2)
}

async function readEnvironment(): Promise<PreviewEnvironment> {
  let extensionId = '(未知)'
  let version = '(未知)'
  try {
    extensionId = runtime.id
    version = runtime.getManifest?.().version ?? '(未知)'
  }
  catch {
    // 非扩展环境（例如单测）下保持未知
  }

  return {
    at: new Date().toISOString(),
    version,
    where: 'sidepanel',
    extensionId,
    idbDatabases: await readIdbDatabases(),
    estimate: await readEstimate(),
  }
}

/**
 * 列出已有的 IndexedDB 库名。
 *
 * 用 `databases()` 而不是 `open()`：后者会把不存在的库创建出来，破坏只读性质。
 * 该 API 在部分宿主上不存在，此时返回 null，报告里明确写「无法检测」——
 * 宁可少一条信息，也不要为了拿到它而破例写一次。
 */
async function readIdbDatabases(): Promise<string[] | null> {
  try {
    // 用 unknown 中转：lib.dom 里 indexedDB 的类型没有 databases()
    const factory = globalThis.indexedDB as unknown as
      | { databases?: () => Promise<Array<{ name?: string }>> }
      | undefined
    if (typeof factory?.databases !== 'function')
      return null
    const list = await factory.databases()
    return list.map(db => db.name ?? '(无名)').sort()
  }
  catch {
    return null
  }
}

async function readEstimate(): Promise<PreviewEnvironment['estimate']> {
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.()
    if (!estimate)
      return null
    return { usage: estimate.usage ?? null, quota: estimate.quota ?? null }
  }
  catch {
    return null
  }
}
