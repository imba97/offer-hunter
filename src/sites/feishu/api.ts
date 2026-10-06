import type { FeishuAtsTenant } from './tenants'
import type { JobView } from '~/logic/types'
import { normalizeLines } from '../text'
import { positionIdFromApiUrl, websitePathFromUrl } from './selectors'

/**
 * 飞书招聘（飞书 ATS）的接口封装。
 *
 * 与 BOSS 那份同构：**这些调用只能在页面上下文（内容脚本）里发起** ——
 * 请求要带站点自己的头（`website-path` 等），且同源 Cookie 也只有页面里有。
 *
 * 与 BOSS 的一处关键差别：飞书招聘的详情接口是**公开**的（无需登录即可读），
 * 所以直链打开岗位页时，即使页面的请求发生在内容脚本装载之前，我们也一定能靠
 * 主动补拉把数据拿回来 —— 也就是说「接口路径」在这个平台上通常比 DOM 更可靠。
 * DOM 仍然实现（见 dom.ts），作为接口不可用时的退路。
 *
 * 本文件里的函数都是**纯逻辑 + 显式传入的租户配置**：平台层不 import 任何具体
 * 租户，租户由同目录的 `site.ts` 组合进来。这样再加一家公司时，这里一行都不用改。
 */

/**
 * 详情接口路径片段。
 *
 * 真机接口：
 *   GET /api/v1/job/posts/<岗位标识>          详情（本文件用的就是它）
 *   GET /api/v1/search/job/posts              列表（**不**监听：界面只分析用户点开的那个岗位）
 *
 * 尾随斜杠是刻意的：`/job/posts/` 只匹配详情（列表是 `/search/job/posts`，
 * 那个 `posts` 后面没有斜杠），因此不必额外写一条「排除列表接口」的判据。
 *
 * ⚠ 这里的响应是**信封** `{ code, data: { job_post_detail }, message, error }`，
 *   但本文件与适配器都按原文处理：解包只发生在 `toJobView` 一处，理由见
 *   sites/types.ts 对 `viewFromApiPayload` 的说明（各家信封不同，是站点私有知识）。
 */
export const JOB_DETAIL_API = '/api/v1/job/posts/'

/**
 * 主动补拉时的固定请求头（除 `website-path`，它按当前地址与该租户的官网路径推算）。
 *
 * `website-path` 是**必需**的：真机验证过，缺了它接口给的详情是空的。
 */
export function buildApiHeaders(tenant: FeishuAtsTenant): HeadersInit {
  return {
    'Accept': 'application/json',
    // 与页面自己发的请求一致：飞书招聘用它决定返回哪种语言的城市名 / 职位类别
    'accept-language': 'zh-CN',
    'website-path': websitePathFromUrl(window.location.href, tenant),
  }
}

/**
 * 拉取岗位详情**原始响应体**。
 *
 * 返回原文而不是解包后的对象：与适配器契约一致（`viewFromApiPayload` 收的也是原文），
 * 解包只发生在 `toJobView` 这一个地方。
 */
async function fetchDetailPayload(positionId: string, tenant: FeishuAtsTenant): Promise<unknown> {
  const res = await fetch(`${JOB_DETAIL_API}${encodeURIComponent(positionId)}`, {
    credentials: 'include',
    headers: buildApiHeaders(tenant),
  })

  if (!res.ok)
    throw new Error(`请求失败 HTTP ${res.status}：${JOB_DETAIL_API}${positionId}`)

  return await res.json()
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 对象下标访问的窄化；不是对象时给一个空对象，让调用点的 `?.` 链保持简短 */
function obj(v: unknown): Record<string, any> {
  return v && typeof v === 'object' ? v as Record<string, any> : {}
}

/**
 * 薪资区间 → 展示文本。
 *
 * 真机字段是 `min_salary: 10, max_salary: 15, currency: 1`，页面上显示 `10-15K`
 * （单位后缀 `CNY/月` 由页面拼）。两个值都以「千」为单位，因此直接按 `K` 展示。
 *
 * 三种情况各自处理，不猜：
 *  - 两个值都有 → `10-15K`
 *  - 只有最小值 → `10K 起`
 *  - 都没有 → 空串（交给上层留空，宁可没有也不要编一个）
 */
function formatSalary(info: Record<string, any>): string {
  const min = num(info.min_salary)
  const max = num(info.max_salary)

  if (min !== undefined && max !== undefined)
    return `${min}-${max}K`
  if (min !== undefined)
    return `${min}K 起`
  if (max !== undefined)
    return `${max}K 以内`
  return ''
}

/**
 * 把「职位描述」与「职位要求」拼成一段 JD 全文。
 *
 * 接口把它们分成两个字段，而页面上是两段带小标题的正文。这里**保留小标题**：
 * 侧边栏与 AI 读到的就是页面的样子，也不会因为少了个「职位要求」而让 AI 以为
 * 那几行是描述的一部分。
 *
 * 两个字段都可能为空（真机上职位要求可以是空的），因此空的那段整块不拼。
 */
function composeJdText(detail: Record<string, any>): string {
  const description = normalizeLines(str(detail.description))
  const requirement = normalizeLines(str(detail.requirement))

  return [
    description ? `职位描述\n${description}` : '',
    requirement ? `职位要求\n${requirement}` : '',
  ].filter(Boolean).join('\n')
}

/**
 * 城市：接口给的是一个数组（同一岗位可以挂在多个城市），真机上只给了杭州一个。
 * 多个城市用 ` / ` 连接 —— 与页面上并列展示的读法一致。
 */
function formatCity(detail: Record<string, any>): string {
  const list = Array.isArray(detail.city_list) ? detail.city_list : []
  return list
    .map(item => str(obj(item).name))
    .filter(Boolean)
    .join(' / ')
}

/** 招聘类型（`全职` / `实习`…）与职位类别（真机上是 `支持`） */
function formatInfoTags(detail: Record<string, any>): { recruitType: string, jobFunction: string } {
  const recruit = obj(detail.recruit_type)
  const jobFunction = obj(detail.job_function)
  return {
    recruitType: str(recruit.name) || str(recruit.i18n_name),
    jobFunction: str(jobFunction.name) || str(jobFunction.i18n_name),
  }
}

/**
 * 从详情响应体原文构造岗位视图。
 *
 * 本函数是「飞书招聘 ATS wire 格式 → 通用领域模型（JobCore）」的**唯一翻译点**，
 * 上层拿到的已经是站点无关的名字（title / company / salary / location）。
 *
 * ⚠ 岗位身份用 `job_post_detail.id`（接口路径最后一段就是它）：它是岗位的自然主键，
 *   跨刷新稳定，不像 BOSS 的 securityId 那样每次访问新签 —— 所以这里直接把它
 *   当作 `naturalKey`（`payload` 里没有 id 时退回调用方给的 `naturalKey`）。
 *
 * ⚠ `tenant` 是必需的：公司名在页面上是不出现的（只有租户子域知道是谁），
 *   只能来自租户配置 —— 而这个字段会进 AI 提示词与账本，不该留空。
 */
export function toJobView(payload: unknown, naturalKey: string, tenant: FeishuAtsTenant): JobView | null {
  const detail = obj(obj(payload).data).job_post_detail
  if (!detail || typeof detail !== 'object')
    return null

  const d = detail as Record<string, any>
  const title = str(d.title)
  if (!title)
    return null

  const city = formatCity(d)
  const { recruitType, jobFunction } = formatInfoTags(d)
  const salary = formatSalary(obj(d.job_post_info))
  const id = str(d.id) || naturalKey

  return {
    job: {
      title,
      // 公司名页面上没有（租户子域才知道是谁），如实取租户配置
      company: tenant.label,
      salary: salary || undefined,
      // 工作城市。`experience` / `degree` 接口里没有对应字段，就不填 ——
      // 面板对缺失字段是容忍的（见 logic/types.ts 的 JobCore 说明）
      location: city ? { city } : undefined,
      // 招聘类型与职位类别塞进已有的两个字段，不新增模型字段：
      // 它们确实是岗位的属性，语义上分别对应「经验/学历」那一栏与「技能标签」那一栏
      experience: recruitType || undefined,
      skills: jobFunction ? [jobFunction] : undefined,
    },
    site: {
      siteId: tenant.id,
      naturalKey: id,
      // 站点私有 id：`job_id` 与岗位标识不是同一个值（真机前者以 …255259 结尾），
      // 原样留着，将来深链用得上，上层不读
      ids: { positionId: id, jobId: str(d.job_id) },
      raw: obj(payload).data,
    },
    jdText: composeJdText(d),
    source: 'api',
    capturedAt: new Date().toISOString(),
  }
}

/**
 * 主动补拉一个岗位的完整视图。
 *
 * 用途：直链打开岗位页时，页面自己的详情请求可能发生在内容脚本装载之前
 * （注入脚本的被动捕获接不到），此时由内容脚本自己补一次。
 */
export async function fetchJobView(positionId: string, tenant: FeishuAtsTenant): Promise<JobView | null> {
  const payload = await fetchDetailPayload(positionId, tenant)
  return toJobView(payload, positionId, tenant)
}

/**
 * 判断一个捕获到的响应体是不是「岗位详情」。
 *
 * 只认详情路径：列表接口（`/search/job/posts`）即使被捕获到也不当作详情，
 * 否则会把一个列表响应当成当前岗位。
 */
export function isDetailApiUrl(url: string): boolean {
  return positionIdFromApiUrl(url) !== ''
}
