import type { JobRecord, Resume, ResumeSourceId } from '~/logic/types'
import { RESUME_SOURCES } from '~/logic/resume-sources/registry'
import { str } from '~/logic/strings'
import { createEmptyResume, JOB_RECORD_FIELDS } from '~/logic/types'

/**
 * 存储层的**纯归一化逻辑**：没有任何 IO、不碰 storage、不依赖 Vue。
 *
 * 单独成文件的原因是一条硬约束：真实迁移（`legacy.ts`）与日常读写
 * （`storage.ts`）都要用它，而前者被后者间接引用 —— 这些函数留在大文件里
 * 就会形成 `storage → store/ready → store/legacy → storage` 的循环。
 *
 * 这里的函数**必须保持纯**：给定输入产出输出，不读存储、不写存储。
 * 好处是迁移干跑可以直接渲染它们的产物（见 docs/indexeddb-migration.md §7.1）。
 *
 * TODO(过渡代码)：本文件里带「历史形状」字样的那几个函数是过渡代码
 * （`reviveLegacyString` / `migrateResumeShape` / `migrateRecordKeys` /
 * `LEGACY_RECORD_FIELD_FALLBACK` 相关），见 docs/transitional-code.md。
 * 它们同时被**日常读路径**用到，所以不能早于迁移模块删除。
 */

// ---------------------------------------------------------------------------
// 基础：复活字符串、按 fallback 合并
// ---------------------------------------------------------------------------

/**
 * 兼容历史上被 JSON 字符串化的存量数据。
 *
 * 早期版本用的是模板自带的 useWebExtensionStorage，它会把值 JSON.stringify
 * 成**字符串**再写入。这里必须先把字符串解析回对象，否则下面 mergeDefaults 的
 * `typeof value !== 'object'` 分支会直接把字符串原样返回 —— 合并完全不发生，
 * 后续读 apiKey 之类的字段就全是 undefined。
 *
 * 导出是为了迁移干跑：报告要区分「原始值是什么类型」，也需要在**复活后**的
 * 对象上做字段比对（否则字符串输入会把全部字段都报成「补上」）。
 */
export function reviveLegacyString(value: unknown): unknown {
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

// ---------------------------------------------------------------------------
// 简历
// ---------------------------------------------------------------------------

/**
 * 补齐每个来源自己的配置对象。
 *
 * 新增一个来源时，存量用户的 `sources` 里没有这个键；设置页的字段是
 * `v-model` 直接绑到 `sources[id][field]` 上的，读到 undefined 就会在渲染期炸。
 * 因此**每个已注册来源都必须有一份完整形状的配置**，哪怕它从没被用过。
 */
export function ensureSourceConfigs(
  sources: Partial<Record<ResumeSourceId, Record<string, unknown>>> | undefined,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const adapter of RESUME_SOURCES) {
    // 以适配器的 createConfig 为准合并：它是什么形状，结果就是什么形状
    out[adapter.id] = { ...adapter.createConfig(), ...(sources?.[adapter.id] ?? {}) }
  }
  return out
}

/**
 * 把「简历来源还是硬编码的 gist 字段」那个版本的存量数据迁到今天的分组形状。
 *
 *   `resume.gist`       → `resume.sources.gist`
 *   `resume.syncedFrom` → `resume.syncedKey`
 *   缺失的其它来源配置 → 由 createConfig 补出
 *
 * 之所以必须做：`resume.gist` 里的 gistId / fileName / token 是用户手填的，
 * 丢了就得重新配；而 `syncedFrom` 丢了会让「刚同步过就别再取」的判断失效
 * （表现是每次打开设置页都重取一次，白烧 GitHub 额度）。
 *
 * 幂等：已经迁过的数据再跑一次不会改动任何东西（返回原对象引用）。
 */
export function migrateResumeShape(raw: unknown): { value: unknown, changed: boolean } {
  if (typeof raw !== 'object' || raw === null)
    return { value: raw, changed: false }

  const source = raw as Record<string, unknown>
  const legacyGist = source.gist
  const hasLegacyGist = typeof legacyGist === 'object' && legacyGist !== null
  const hasLegacySynced = source.syncedFrom !== undefined
  const sources = source.sources

  if (!hasLegacyGist && !hasLegacySynced)
    return { value: raw, changed: false }

  const next: Record<string, unknown> = { ...source }

  if (hasLegacyGist) {
    // 只在还没迁过时填，避免覆盖新形状里已有的配置
    const merged = ensureSourceConfigs({
      ...(typeof sources === 'object' && sources !== null
        ? sources as Partial<Record<ResumeSourceId, Record<string, unknown>>>
        : {}),
      gist: legacyGist as Record<string, unknown>,
    })
    next.sources = merged
    delete next.gist
  }

  if (hasLegacySynced) {
    next.syncedKey = source.syncedFrom
    delete next.syncedFrom
  }

  return { value: next, changed: true }
}

/**
 * 把简历文档归一成最终要落库的形状（迁移与启动初始化共用）。
 *
 * 顺序不能改，三步之间有依赖：
 *  1. **先复活字符串**：早期版本把值 JSON 字符串化过，而 `migrateResumeShape`
 *     只认对象 —— 直接喂字符串会让 legacy `gist` **永远迁不动**。
 *     这个组合是真实存在的（字符串化与 `resume.gist` 属于同一个年代），
 *     干跑预览正是靠这里才发现它。`mergeDefaults` 内部也做复活，所以重复调用安全。
 *  2. `migrateResumeShape` 必须在 `mergeDefaults` **之前**跑：后者只认 fallback
 *     （`createEmptyResume`）声明过的键，会先把 `gist` / `syncedFrom` 裁掉，
 *     裁完就再也迁不动了。
 *  3. 最后补来源配置：每个已注册来源都必须有完整形状。
 */
export function normalizeResumeDoc(raw: unknown): Resume {
  const revived = reviveLegacyString(raw)
  const merged = mergeDefaults(revived, createEmptyResume())
  const migrated = migrateResumeShape(revived)
  const base = migrated.changed
    ? mergeDefaults(migrated.value, createEmptyResume())
    : merged

  return { ...base, sources: ensureSourceConfigs(base.sources) }
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

/**
 * 把「账本键只是 securityId」那个版本的存量数据迁到站点命名空间键。
 *
 *   `abc123`              → `boss:abc123`
 *   `record.securityId`   → `record.naturalKey`，并补上 `record.siteId`
 *
 * 为什么必须做：键没有站点命名空间时，两个站点的岗位标识撞车会把 A 站的分析结果
 * 显示到 B 站的岗位上（缓存命中错误的记录）。而**存量数据一律属于 BOSS** ——
 * 加第二个站点之前，扩展只支持 BOSS 一家，这个前提让迁移是确定的、不需要猜。
 *
 * 幂等：已经带命名空间（键里有 `:`）的数据原样保留，第二次运行不做任何改动。
 */
export function migrateRecordKeys(all: Record<string, JobRecord>): boolean {
  let changed = false

  for (const [key, record] of Object.entries(all)) {
    if (!record || typeof record !== 'object') {
      delete all[key]
      changed = true
      continue
    }

    const legacy = record as JobRecord & { securityId?: unknown }

    /*
     * 键里带 `:` 说明已经迁过。这里刻意**不**用「字段在不在」判断：
     * 一条刚写入的新记录两种信息都有，用键判断最省事也最不容易误判。
     */
    if (key.includes(':'))
      continue

    const siteId = typeof legacy.siteId === 'string' && legacy.siteId ? legacy.siteId : 'boss'
    const naturalKey = typeof legacy.naturalKey === 'string' && legacy.naturalKey
      ? legacy.naturalKey
      : (typeof legacy.securityId === 'string' ? legacy.securityId : key)

    delete legacy.securityId
    legacy.siteId = siteId
    legacy.naturalKey = naturalKey

    delete all[key]
    all[recordKeyOf(siteId, naturalKey)] = record
    changed = true
  }

  return changed
}

/** 与 `types.ts` 的 `recordKey()` 同一拼法；这里内联一份避免纯函数模块反向依赖 */
function recordKeyOf(siteId: string, naturalKey: string): string {
  return `${siteId}:${naturalKey}`
}

/**
 * 重构前那套「接口原名」字段（`types.ts:197` 记录了这次重构：
 * 「jobName→title、brandName→company、bossName→recruiter」）。
 *
 * 真机干跑显示存量账本里这类记录占多数（59/86），而且它们**不会被
 * `mergeDefaults` 裁掉** —— 账本是动态键映射，那个函数刻意不对它做裁剪。
 */
const LEGACY_RECORD_FIELD_FALLBACK = {
  title: 'jobName',
  company: 'brandName',
  recruiterName: 'bossName',
  salary: 'salaryDesc',
} as const

/**
 * 把账本记录**按当前模型重建**（白名单式归一）。
 *
 * 为什么是白名单而不是「删掉已知的旧字段」：存储里躺着的历史字段追不完 ——
 * 真机上就看到 `jdText`、`encryptJobId`、`encryptBossId`、`haveChatted`、
 * `isFriend`、`lastAction`、`lastTouchedDate`、`address`、`cityName`、`skills`…
 * 共 23 个字段名。逐个删的清单一定会漏，白名单天然不会。
 *
 * 顺带接替了原先 `stripRemovedRecordFields` 的职责：`status` 不在白名单里，
 * 自然被丢掉 —— 两套机制合成一套。
 *
 * ⚠ 这里的字面量必须满足 `JobRecord`：给模型增删字段而忘了同步，
 *   **编译就过不去**（这是选择显式构造而不是循环搬字段的原因）。
 *
 * 幂等：字段集合已经一致的记录原样保留（不比较值），重复运行不会反复重写。
 */
export function normalizeRecordShape(all: Record<string, JobRecord>): boolean {
  let changed = false

  for (const [key, record] of Object.entries(all)) {
    if (!record || typeof record !== 'object')
      continue

    const source = record as JobRecord & Record<string, unknown>

    // 身份以**键**为准（`<siteId>:<naturalKey>`）：字段缺失时从键里回填，
    // 免得留下一条「查得到、但身份为空」的记录
    const siteId = str(source.siteId) || keySiteId(key)
    const naturalKey = str(source.naturalKey) || keyNaturalKey(key, siteId)

    const next: JobRecord = {
      siteId,
      naturalKey,
      title: str(pickWithLegacyName(source, 'title')),
      company: str(pickWithLegacyName(source, 'company')),
      recruiterName: str(pickWithLegacyName(source, 'recruiterName')),
      salary: str(pickWithLegacyName(source, 'salary')),
      match: coerceStoredMatch(source.match),
      greeting: typeof source.greeting === 'string' ? source.greeting : null,
      error: typeof source.error === 'string' ? source.error : null,
      firstSeen: str(source.firstSeen),
    }

    if (sameFieldSet(source, next))
      continue

    all[key] = next
    changed = true
  }

  return changed
}

/** 取当前字段名的值；缺了就回退到重构前的接口原名 */
function pickWithLegacyName(
  source: Record<string, unknown>,
  field: keyof typeof LEGACY_RECORD_FIELD_FALLBACK,
): unknown {
  return source[field] ?? source[LEGACY_RECORD_FIELD_FALLBACK[field]]
}

/**
 * 从账本键 `siteId:naturalKey` 里取站点 id（按**第一个** `:` 切）。
 *
 * 只在记录字段缺失时兜底。真机上走不到（86/86 条记录两个字段都在），
 * 但「键里有身份、字段里没有」的记录一旦出现，空身份会让它既查不到也用不了。
 */
function keySiteId(key: string): string {
  const at = key.indexOf(':')
  return at > 0 ? key.slice(0, at) : ''
}

/** 键里 `siteId:` 之后的部分即 naturalKey */
function keyNaturalKey(key: string, siteId: string): string {
  return siteId ? key.slice(siteId.length + 1) : key
}

/**
 * 存量 `match` 的防御性收敛：**只修已经坏掉的形状**，完好的原样返回（连引用都不换）。
 *
 * 面板会 `match.reasons.join()`，缺了数组就直接抛 —— 而这个字段是旧版本写下的，
 * 形状无从保证。刻意不做完整校验（那属于 AI 返回值的活，见
 * platform/ai/matching.ts 的 normalizeMatchResult）：这里只兜住会让界面崩掉的那一种。
 */
function coerceStoredMatch(value: unknown): JobRecord['match'] {
  if (value === null || value === undefined)
    return null
  if (typeof value !== 'object')
    return null

  const raw = value as Record<string, unknown>
  const broken = !Array.isArray(raw.reasons) || !Array.isArray(raw.missingSkills)
  if (!broken)
    return value as JobRecord['match']

  const score = typeof raw.score === 'number' ? raw.score : Number(raw.score)
  return {
    score: Number.isFinite(score) ? score : 0,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    reasons: Array.isArray(raw.reasons) ? raw.reasons.filter(item => typeof item === 'string') : [],
    missingSkills: Array.isArray(raw.missingSkills) ? raw.missingSkills.filter(item => typeof item === 'string') : [],
  }
}

/** 字段集合是否一致（只比名字，不比值 —— 值的变化不该由这里负责） */
function sameFieldSet(a: object, b: object): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  return ak.length === bk.length && ak.every(key => key in b)
}

/**
 * 把账本归一成最终要落库的形状，并报告「是否需要写回」。
 *
 * ⚠ 这里**不短路**：键改名与字段归一都会跑，哪怕前者已经改过东西。
 *   旧实现写的是 `migrateRecordKeys(all) || stripRemovedRecordFields(all)`，
 *   于是「键要改名」的那一次会把字段清理整个跳过（`||` 短路），要等下一次
 *   启动才补上 —— 结果一样，但白白多一轮。
 */
export function normalizeRecordLedger(raw: unknown): { value: Record<string, JobRecord>, changed: boolean } {
  const needWrite = raw === undefined || raw === null || typeof raw === 'string'
  const value = mergeDefaults(raw, {}) as Record<string, JobRecord>
  // 先修键（legacy 键只有 securityId，得先补出 siteId/naturalKey），再按模型重建记录
  const keysMigrated = migrateRecordKeys(value)
  const shapeNormalized = normalizeRecordShape(value)

  return { value, changed: needWrite || keysMigrated || shapeNormalized }
}

/** 账本记录的字段清单（供报告判断「哪些字段是模型外的」） */
export const KNOWN_RECORD_FIELDS: readonly string[] = Object.keys(JOB_RECORD_FIELDS)
