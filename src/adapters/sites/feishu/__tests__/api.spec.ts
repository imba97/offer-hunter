import type { FeishuAtsTenant } from '../site'
import type { SiteMeta } from '~/adapters/sites/types'
import type { JobView } from '~/logic/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDetailApiUrl, JOB_DETAIL_API, toJobView } from '../api'
import { positionIdFromApiUrl } from '../selectors'
import { feishuAtsSite } from '../site'

/**
 * 飞书招聘（飞书 ATS）**接口翻译**的测试。
 *
 * 这个平台的岗位数据主路径是接口，所以这里的断言就是它的取数契约：飞书招聘的
 * 信封（`{ code, data: { job_post_detail } }`）能不能翻成通用岗位模型。
 *
 * 样本照抄真机响应（影视飓风租户，`GET /api/v1/job/posts/7673106028406786331`
 * 带 `website-path: index` 头），只裁掉与翻译无关的大段字段：
 *
 * ```json
 * { "code": 0, "message": "ok", "error": null,
 *   "data": { "job_post_detail": {
 *     "id": "7673106028406786331", "title": "楼宇工程", "job_id": "7673106028406655259",
 *     "description": "1.负责跟进公司楼宇建设项目…\n2.负责所有楼宇空间维保事项…",
 *     "requirement": "1.有2年以上楼宇工程管理经验…\n2.有良好的项目管理和预算把控能力；…",
 *     "recruit_type": { "name": "全职" },
 *     "job_function": { "name": "支持" },
 *     "city_list": [{ "name": "杭州" }],
 *     "job_post_info": { "min_salary": 10, "max_salary": 15, "currency": 1 } } } }
 * ```
 *
 * ⚠ 测试用影视飓风这个租户驱动（它是租户表里的第一个），但断言的是**平台层**的
 *   行为：换一家租户（改 `label`）能得到的差异只有公司名与站点 id。
 */

const POSITION_ID = '7673106028406786331'
const DETAIL_URL = `${JOB_DETAIL_API}${POSITION_ID}`

/** 与 sites/mediastorm/meta.ts 一致（改成别的值即可模拟另一家租户） */
const META: SiteMeta & { source: 'api' } = {
  id: 'mediastorm',
  label: '影视飓风',
  jobsPageUrl: 'https://mediastorm.jobs.feishu.cn/index/position',
  source: 'api',
  color: '#d8152a',
  textColor: '#ffffff',
  matches: ['*://mediastorm.jobs.feishu.cn/*'],
  hostnames: ['mediastorm.jobs.feishu.cn'],
}

/** 接口与 DOM 层要的「完整租户」：站点描述 + 平台上的位置 */
const TENANT: FeishuAtsTenant = { meta: META, subdomain: 'mediastorm', path: 'index' }

const site = feishuAtsSite(META, TENANT)

/** 真机响应体（与线上字段名、层级逐字一致） */
function realPayload(): unknown {
  return {
    code: 0,
    data: {
      job_post_detail: {
        id: POSITION_ID,
        title: '楼宇工程',
        description: '1.负责跟进公司楼宇建设项目，合理把控施工进度，控制建设成本，保障交付成果符合预期；\n2.负责所有楼宇空间维保事项，储备维保供应商，优化维护成本，保障楼宇空间正常使用。',
        requirement: '1.有2年以上楼宇工程管理经验，交付过大面积办公场地项目经验优先；\n2.有良好的项目管理和预算把控能力；\n3.有较高的装饰装修审美能力；\n4.沟通能力佳，责任心强，自驱力佳。',
        recruit_type: { id: '101', name: '全职', i18n_name: '全职' },
        job_function: { id: '7300499903662573851', name: '支持', i18n_name: '支持' },
        job_id: '7673106028406655259',
        city_list: [{ code: 'CT_52', name: '杭州', en_name: 'Hangzhou' }],
        job_post_info: { min_salary: 10, max_salary: 15, currency: 1 },
      },
      recommend_job_post_List: [],
    },
    message: 'ok',
    error: null,
  }
}

/** 接口地址 → 岗位标识（内容脚本从捕获到的 URL 推身份时走的就是它） */
describe('岗位标识（positionIdFromApiUrl）', () => {
  it('从详情接口地址里取标识', () => {
    expect(positionIdFromApiUrl(DETAIL_URL)).toBe(POSITION_ID)
    // 带查询串 / 末尾斜杠也要认
    expect(positionIdFromApiUrl(`${DETAIL_URL}?website_path=index`)).toBe(POSITION_ID)
    expect(positionIdFromApiUrl(`${DETAIL_URL}/`)).toBe(POSITION_ID)
  })

  it('列表接口不给标识（否则会把列表响应当成当前岗位）', () => {
    expect(positionIdFromApiUrl('/api/v1/search/job/posts')).toBe('')
    expect(positionIdFromApiUrl('/api/v1/job/posts')).toBe('')
  })
})

describe('isDetailApiUrl', () => {
  it('只认详情路径', () => {
    expect(isDetailApiUrl(DETAIL_URL)).toBe(true)
    expect(isDetailApiUrl('/api/v1/search/job/posts')).toBe(false)
    expect(isDetailApiUrl('https://mediastorm.jobs.feishu.cn/api/v1/website/info')).toBe(false)
  })
})

describe('toJobView：接口响应 → 通用岗位模型', () => {
  it('翻出标题 / 薪资 / 城市 / 招聘类型 / 职位类别', () => {
    const view = toJobView(realPayload(), POSITION_ID, TENANT)

    expect(view).not.toBeNull()
    expect(view!.job.title).toBe('楼宇工程')
    // 页面上不出现公司名（租户子域才知道是谁），如实取租户配置
    expect(view!.job.company).toBe('影视飓风')
    // 真机 `min_salary: 10, max_salary: 15` 在页面上就是 `10-15K`
    expect(view!.job.salary).toBe('10-15K')
    expect(view!.job.location).toEqual({ city: '杭州' })
    expect(view!.job.experience).toBe('全职')
    expect(view!.job.skills).toEqual(['支持'])
  })

  it('jD 全文带上「职位描述」「职位要求」两个小标题', () => {
    const view = toJobView(realPayload(), POSITION_ID, TENANT)

    expect(view!.jdText).toContain('职位描述')
    expect(view!.jdText).toContain('负责跟进公司楼宇建设项目')
    expect(view!.jdText).toContain('职位要求')
    expect(view!.jdText).toContain('沟通能力佳，责任心强，自驱力佳')
    // 小标题在前、正文在后（顺序有意义：AI 靠它区分描述与要求）
    expect(view!.jdText.indexOf('职位描述')).toBeLessThan(view!.jdText.indexOf('职位要求'))
  })

  it('岗位身份是接口给的 id（自然主键，跨刷新稳定）', () => {
    const view = toJobView(realPayload(), '调用方给的兜底标识', TENANT)

    expect(view!.site.siteId).toBe('mediastorm')
    expect(view!.site.naturalKey).toBe(POSITION_ID)
    // job_id 与岗位标识不是同一个值，原样留在站点私有字段里
    expect(view!.site.ids?.jobId).toBe('7673106028406655259')
    expect(view!.source).toBe('api')
  })

  it('换一个租户只影响公司名与站点 id（平台逻辑共用）', () => {
    const otherMeta = { ...META, id: 'acme', label: '某某科技' }
    const other: FeishuAtsTenant = { ...TENANT, meta: otherMeta, subdomain: 'acme' }
    const view = toJobView(realPayload(), POSITION_ID, other)

    expect(view!.job.company).toBe('某某科技')
    expect(view!.site.siteId).toBe('acme')
  })

  it('接口没给 id 时退回调用方给的标识（不造一个假身份）', () => {
    const payload = realPayload() as any
    delete payload.data.job_post_detail.id

    expect(toJobView(payload, POSITION_ID, TENANT)!.site.naturalKey).toBe(POSITION_ID)
  })

  it('薪资缺失时留空，不编一个数字', () => {
    const payload = realPayload() as any
    payload.data.job_post_detail.job_post_info = {}

    expect(toJobView(payload, POSITION_ID, TENANT)!.job.salary).toBeUndefined()
  })

  it('只有最小薪资时给出「起」的写法', () => {
    const payload = realPayload() as any
    payload.data.job_post_detail.job_post_info.max_salary = undefined

    expect(toJobView(payload, POSITION_ID, TENANT)!.job.salary).toBe('10K 起')
  })

  it('职位要求为空时只留「职位描述」那一段', () => {
    const payload = realPayload() as any
    payload.data.job_post_detail.requirement = ''

    const jd = toJobView(payload, POSITION_ID, TENANT)!.jdText
    expect(jd).toContain('职位描述')
    expect(jd).not.toContain('职位要求')
  })

  it('多个城市并列展示', () => {
    const payload = realPayload() as any
    payload.data.job_post_detail.city_list = [{ name: '杭州' }, { name: '上海' }]

    expect(toJobView(payload, POSITION_ID, TENANT)!.job.location).toEqual({ city: '杭州 / 上海' })
  })

  it('信封不对（列表响应 / 报错 / 空值）一律返回 null，交给 DOM 兜底', () => {
    expect(toJobView(null, POSITION_ID, TENANT)).toBeNull()
    expect(toJobView({ code: 0, data: {} }, POSITION_ID, TENANT)).toBeNull()
    expect(toJobView({ code: 0, data: { job_post_detail: { title: '' } } }, POSITION_ID, TENANT)).toBeNull()
    // 真机上列表接口给的是 search_result 之类的结构，没有 job_post_detail
    expect(toJobView({ code: 0, data: { job_post_list: [] } }, POSITION_ID, TENANT)).toBeNull()
  })
})

/**
 * 主动补拉：这条路径的**请求头**是平台契约的一部分。
 *
 * 真机验证过：不带 `website-path: index` 时接口给的详情是空的，
 * 所以这里把请求连同头一起断言住 —— 它是最容易静默失效的地方。
 */
describe('fetchView：主动补拉（内容脚本持有页面上下文）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function stubLocation(href: string): void {
    vi.stubGlobal('location', { href, origin: new URL(href).origin })
  }

  it('请求详情接口，并带上 website-path 头', async () => {
    stubLocation('https://mediastorm.jobs.feishu.cn/index/position/7673106028406786331/detail')
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => realPayload() }))
    vi.stubGlobal('fetch', fetchMock)

    const view = await site.fetchView(POSITION_ID)

    expect(view?.job.title).toBe('楼宇工程')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(DETAIL_URL)
    expect(init.credentials).toBe('include')
    expect((init.headers as Record<string, string>)['website-path']).toBe('index')
  })

  it('站内路由形态的地址也推得出官网路径（/position/detail/<id> → 租户配置的 path）', async () => {
    stubLocation('https://mediastorm.jobs.feishu.cn/position/detail/7673106028406786331')
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => realPayload() }))
    vi.stubGlobal('fetch', fetchMock)

    await site.fetchView(POSITION_ID)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['website-path']).toBe('index')
  })

  it('官网路径不是 index 的租户用的是自己的路径', async () => {
    const otherMeta = { ...META, id: 'acme', matches: ['*://acme.jobs.feishu.cn/*'] }
    const other = feishuAtsSite(otherMeta, { subdomain: 'acme', path: 'campus' })
    // 列表页地址（第一段就是官网路径）
    stubLocation('https://acme.jobs.feishu.cn/campus/position')
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => realPayload() }))
    vi.stubGlobal('fetch', fetchMock)

    await other.fetchView(POSITION_ID)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['website-path']).toBe('campus')
  })

  it('hTTP 失败时抛错（由内容脚本捕获后退回 DOM 兜底）', async () => {
    stubLocation('https://mediastorm.jobs.feishu.cn/index/position/7673106028406786331/detail')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))

    await expect(site.fetchView(POSITION_ID)).rejects.toThrow('HTTP 500')
  })

  it('详情探针回答「标识 → JD」这条契约还在不在', async () => {
    stubLocation('https://mediastorm.jobs.feishu.cn/index/position/7673106028406786331/detail')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => realPayload() })))

    const probe = await site.probeDetail(POSITION_ID)
    expect(probe.hasDescription).toBe(true)
    expect(probe.preview).toContain('职位描述')
  })
})

/** 适配器声明的可捕获路径必须与接口路径同源（manifest 靠它注入 MAIN world 脚本） */
describe('接口契约声明', () => {
  it('监听的是详情路径，且不是列表路径', () => {
    expect(site.kind).toBe('api')
    expect(site.manifest.watchedApiPaths).toEqual([JOB_DETAIL_API])
    // 列表响应不会被误当成详情
    expect(site.isDetailApiUrl('/api/v1/search/job/posts')).toBe(false)
  })

  it('dOM 兜底能造出带站点身份的岗位（没有接口数据时也不丢账本键）', () => {
    const view: JobView = site.buildDomFallback('JD 正文', {
      site: site.emptyRef(POSITION_ID),
    }, { jobName: '楼宇工程', brandName: '' })

    expect(view.site.siteId).toBe('mediastorm')
    expect(view.site.naturalKey).toBe(POSITION_ID)
    expect(view.source).toBe('dom')
  })
})
