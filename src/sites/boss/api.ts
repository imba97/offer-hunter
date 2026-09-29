import type { JobView } from '~/logic/types'
import { stripCssNoise } from './jd'

/**
 * BOSS 直聘接口封装。
 *
 * ⚠ 架构硬约束：/wapi/ 接口只认浏览器会话 Cookie，且 MV3 的 service worker
 * 发起的请求不带页面 Cookie，因此**这些调用只能在页面上下文（内容脚本）里发起**，
 * 不能放到后台。
 *
 * ⚠ 字段契约来自社区实测记录 + 本项目的实际响应诊断。平台改版即可能失效，
 * 面板的「诊断」标签可以复验。
 */

interface ZpResponse<T> {
  code: number
  message?: string
  msg?: string
  zpData?: T
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })

  if (!res.ok)
    throw new Error(`请求失败 HTTP ${res.status}：${url}`)

  const data = await res.json() as ZpResponse<T>

  if (data.code !== 0 || data.zpData === undefined) {
    const msg = data.message ?? data.msg ?? `code=${data.code}`
    throw new Error(`接口返回异常：${msg}`)
  }

  return data.zpData
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function bool(v: unknown): boolean {
  return v === true || v === 1
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * 从 /wapi/zpgeek/job/detail.json 的 zpData 构造岗位视图。
 *
 * 详情响应里既有 jobInfo（岗位本身）也有 bossInfo / brandComInfo（招聘者与公司），
 * 因此**不需要列表接口**就能拿到面板要展示的全部信息。
 *
 * 本函数是 BOSS wire 格式 → 通用领域模型（JobCore）的**唯一翻译点**。
 * 上层拿到的已经是站点无关的名字（title / company / recruiter），因此
 * 再加一个招聘网站时，matching.ts 与侧边栏不需要改 —— 只有新的适配器
 * 写自己那一份 toJobView。
 *
 * ⚠ 薪资必须取接口字段：DOM 里是字体加密的私用区字符，读出来是乱码。
 */
export function toJobView(zpData: unknown, securityId: string): JobView | null {
  const zp = zpData as any
  const jobInfo = zp?.jobInfo
  if (!jobInfo || typeof jobInfo !== 'object')
    return null

  const bossInfo = zp?.bossInfo ?? {}
  const brand = zp?.brandComInfo ?? zp?.brandInfo ?? {}

  const title = str(jobInfo.jobName)
  if (!title)
    return null

  // 城市 / 区域：部分响应是拼好的 locationName，部分是分散字段
  const locationName = str(jobInfo.locationName)
  const [cityName = '', areaDistrict = '', businessDistrict = ''] = locationName
    .split(/[·\s]+/)
    .filter(Boolean)

  const city = str(jobInfo.cityName) || cityName
  const district = str(jobInfo.areaDistrict) || areaDistrict
  const business = str(jobInfo.businessDistrict) || businessDistrict
  const bossName = str(bossInfo.name)
  const skills = strArray(jobInfo.showSkills).length > 0
    ? strArray(jobInfo.showSkills)
    : strArray(jobInfo.skills)

  return {
    job: {
      title,
      company: str(brand.brandName) || str(brand.name) || undefined,
      salary: str(jobInfo.salaryDesc) || undefined,
      experience: str(jobInfo.experienceName) || str(jobInfo.jobExperience) || undefined,
      degree: str(jobInfo.degreeName) || str(jobInfo.jobDegree) || undefined,
      // 三个层级一个都没有时给 undefined，而不是留一个全空对象让 UI 判断
      location: (city || district || business)
        ? { city: city || undefined, district: district || undefined, businessDistrict: business || undefined }
        : undefined,
      skills: skills.length > 0 ? skills : undefined,
      companyIndustry: str(brand.industryName) || undefined,
      companyScale: str(brand.scaleName) || undefined,
      companyStage: str(brand.stageName) || undefined,
      recruiter: bossName
        ? {
            name: bossName,
            title: str(bossInfo.title) || undefined,
            online: bool(bossInfo.online),
          }
        : undefined,
    },
    site: {
      siteId: 'boss',
      /*
       * ⚠ 故意**不**把 securityId 当身份，尽管它是详情接口的钥匙。
       *
       * 真机症状：同一个岗位每刷新一次就变成另一个 `boss:<一长串>`，刚存进账本的分析
       * 结果再也查不到 —— 因为 BOSS **每次访问都会新签一个 securityId**，它不是岗位的
       * 稳定标识，只是一次性的取数凭据。
       *
       * 所以身份留空，交给 `jobIdentity` 的内容摘要（标题 + JD 开头）兜底：那一份只
       * 依赖岗位内容，跨刷新稳定。token 放进 `ids.securityId`，继续供重新取数与深链使用。
       */
      naturalKey: '',
      // BOSS 私有 id 原样留着：将来深链/刷新用得上，但上层不该读它们
      ids: {
        securityId,
        encryptJobId: str(jobInfo.encryptJobId),
        encryptBossId: str(bossInfo.encryptBossId) || str(jobInfo.encryptBossId),
      },
      raw: zp,
    },
    // 接口的 postDescription 通常是纯文本，但仍过一遍清洗：
    // 平台偶尔会把带水印标记的片段混进接口字段
    jdText: stripCssNoise(str(jobInfo.postDescription)),
    address: str(jobInfo.address) || undefined,
    source: 'api',
    capturedAt: new Date().toISOString(),
  }
}

/**
 * 拉取岗位详情原始数据（含 JD 全文）。
 *
 * 注意用 securityId 而不是 encryptJobId —— 这是详情接口的钥匙。
 */
async function fetchDetailData(securityId: string): Promise<any> {
  return await getJson<any>(
    `/wapi/zpgeek/job/detail.json?securityId=${encodeURIComponent(securityId)}`,
  )
}

/**
 * 详情接口的原始正文形态，只给诊断探针用。
 *
 * 刻意留在站点侧、不做成通用模型：它的唯一用途是回答「postDescription 这个
 * BOSS 字段还在不在」，也就是 securityId → JD 这条契约有没有失效。
 * 放进 JobCore 会逼着通用模型多背一个站点私有字段。
 */
export interface JobDetail {
  jdText: string
  address: string
  skills: string[]
}

/** 岗位详情（诊断探针用的原始形态） */
export async function fetchJobDetail(securityId: string): Promise<JobDetail> {
  const zpData = await fetchDetailData(securityId)
  const jobInfo = zpData?.jobInfo ?? {}

  return {
    jdText: stripCssNoise(str(jobInfo.postDescription)),
    address: str(jobInfo.address),
    skills: strArray(jobInfo.showSkills),
  }
}

/**
 * 主动拉取一个岗位的完整视图。
 *
 * 用途：页面命中缓存 / 直链打开 `…/job?securityId=xxx` 时，详情响应可能在
 * 内容脚本装载之前就已经发完（注入脚本的被动捕获接不到），此时由内容脚本
 * 自己补一次请求 —— 内容脚本持有页面 Cookie，这正是它能做的事。
 */
export async function fetchJobView(securityId: string): Promise<JobView | null> {
  const zpData = await fetchDetailData(securityId)
  return toJobView(zpData, securityId)
}

/** 详情接口路径，用于判断捕获到的响应体类型 */
export const JOB_DETAIL_API = 'job/detail.json'
