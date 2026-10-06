import type { FeishuAtsTenant } from '../site'
import type { SiteMeta } from '~/adapters/sites/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildDomFallbackJob,
  getDetailPanel,
  getJdElement,
  readJdFromDom,
  readJobOutlineFromDom,
  readSalaryFromDom,
} from '../dom'
import { positionIdFromUrl, websitePathFromUrl } from '../selectors'
import { feishuAtsSite } from '../site'

/**
 * 飞书招聘（飞书 ATS）适配器的 DOM 读取测试。
 *
 * 这个平台的接口是主路径，DOM 是**接口没捕获到时的兜底**；因此这里钉住的是
 * 「兜底还能给出什么」：标题、薪资、正文，以及容器探针的契约。
 *
 * 结构照抄真机（影视飓风租户的详情页）：
 *
 *   <div class="jobDetail__f7613e jobDetail">
 *     <div class="job-header sofiaBold"><span data-test="jobTitle" class="job-title">楼宇工程</span></div>
 *     <div class="job-money">10-15K<span class="job-money-unit">CNY/月</span></div>
 *     <div class="job-info">…杭州 / 全职 / 支持…</div>
 *     <div class="block-title">职位描述</div>
 *     <div class="block-content">…</div>
 *     <div class="block-title">职位要求</div>
 *     <div class="block-content">…</div>
 *     <div class="apply-block"><button>投递</button></div>
 *   </div>
 *
 * ⚠ 类名里的 hash（`__f7613e`）是构建期生成的，测试里照样写上：选择器用的是
 *   子串匹配（见 selectors.ts 的 HASH 说明），带上 hash 才验证得了「平台换 hash
 *   之后还认不认」——这正是这一组用例存在的理由。
 */

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

function mountPanel(options: {
  title?: string
  salary?: string
  description?: string
  requirement?: string
} = {}): void {
  const { title = '楼宇工程', salary = '10-15K', description = '负责跟进公司楼宇建设项目。', requirement = '有2年以上楼宇工程管理经验。' } = options

  document.body.innerHTML = `
    <div class="jobDetail__f7613e jobDetail" style="transform: translate(0px, 0px); opacity: 1;">
      <div class="job-header sofiaBold">
        <span data-test="jobTitle" class="job-title">${title}</span>
      </div>
      ${salary ? `<div class="job-money">${salary}<span class="job-money-unit">CNY/月</span></div>` : ''}
      <div class="job-info">
        <span class="infoText__f7613e"><span class="content__346a5c clamp-content">杭州</span></span>
        <div class="lineDevider__77ceb8 line-devider-job-detail__f7613e"></div>
        <span class="infoText__f7613e">全职</span>
        <div class="lineDevider__77ceb8 line-devider-job-detail__f7613e"></div>
        <span class="infoText__f7613e"><span class="content__346a5c clamp-content">支持</span></span>
      </div>
      <div class="job-content__f7613e">
        <div class="block-title">职位描述</div>
        <div class="block-content">${description}</div>
        ${requirement ? `<div class="block-title">职位要求</div><div class="block-content">${requirement}</div>` : ''}
      </div>
      <div class="apply-block">
        <button type="button" class="atsx-btn apply-block-applyBtn atsx-btn-primary atsx-btn-lg"><span>投递</span></button>
      </div>
    </div>
  `
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('岗位名与公司名（readJobOutlineFromDom）', () => {
  it('岗位名读 data-test="jobTitle"（平台自己给的稳定钩子）', () => {
    mountPanel()

    expect(readJobOutlineFromDom(TENANT)).toEqual({ jobName: '楼宇工程', brandName: '影视飓风' })
  })

  it('面板还没渲染时返回空串（不猜）', () => {
    document.body.innerHTML = '<div>别的页面</div>'

    expect(readJobOutlineFromDom(TENANT)).toEqual({ jobName: '', brandName: '' })
  })

  it('岗位名超长时不算标题（避免把整段描述当成名字）', () => {
    mountPanel({ title: '岗位名'.repeat(20) })

    expect(readJobOutlineFromDom(TENANT).jobName).toBe('')
  })
})

describe('薪资（readSalaryFromDom）', () => {
  it('摘掉单位后缀，只留区间（与接口那条路的文本一致）', () => {
    mountPanel()

    expect(readSalaryFromDom()).toBe('10-15K')
  })

  it('没有薪资行时返回空串', () => {
    mountPanel({ salary: '' })

    expect(readSalaryFromDom()).toBe('')
  })
})

/*
 * 下面两个 `describe` 的名字以缩写开头（JD / DOM）。`test/prefer-lowercase-title`
 * 会强行把首字母改成小写（`jD` / `dOM`），而那种写法是错的 —— 缩写要么全大写、
 * 要么全小写。这里显式关掉那条规则，保留正确的大小写。
 */
// eslint-disable-next-line test/prefer-lowercase-title
describe('JD 读取（readJdFromDom）', () => {
  it('按文档顺序接起两段 block-content', () => {
    mountPanel()

    const jd = readJdFromDom()
    expect(jd).toContain('负责跟进公司楼宇建设项目。')
    expect(jd).toContain('有2年以上楼宇工程管理经验。')
    expect(jd!.indexOf('负责跟进')).toBeLessThan(jd!.indexOf('有2年以上'))
    // 小标题不进正文：接口那条路的小标题由字段名补，页面文案不保证与接口对齐
    expect(jd).not.toContain('职位描述')
  })

  it('职位要求为空时只剩描述那一段', () => {
    mountPanel({ requirement: '' })

    expect(readJdFromDom()).toBe('负责跟进公司楼宇建设项目。')
  })

  it('jD 块容器改版时退回面板里的 block-content（只改外层类名不失守）', () => {
    document.body.innerHTML = `
      <div class="jobDetail__f7613e jobDetail">
        <span data-test="jobTitle" class="job-title">楼宇工程</span>
        <div class="whatever-they-renamed-it">
          <div class="block-content">第一段</div>
          <div class="block-content">第二段</div>
        </div>
      </div>
    `

    expect(readJdFromDom()).toBe('第一段\n第二段')
  })

  it('连 block-content 都改版时退回整段面板文本（宁可多两个按钮字，也不要空手而归）', () => {
    document.body.innerHTML = `
      <div class="jobDetail__f7613e jobDetail">
        <span data-test="jobTitle" class="job-title">楼宇工程</span>
        <div class="renamed-body">负责跟进公司楼宇建设项目。</div>
      </div>
    `

    expect(readJdFromDom()).toContain('负责跟进公司楼宇建设项目。')
  })

  it('面板不存在时返回 null（内容脚本于是不会产生任何岗位）', () => {
    document.body.innerHTML = '<div>别的页面</div>'

    expect(readJdFromDom()).toBeNull()
  })
})

describe('观察器容器与探针', () => {
  it('探针是正文块容器，容器是整个面板', () => {
    mountPanel()

    expect(getJdElement()?.className).toContain('job-content')
    // 盯面板而不是正文块：换岗位时正文块会被整块替换，盯内层就失联了
    expect(getDetailPanel()?.className).toContain('jobDetail')
  })

  it('列表页（没有详情面板）两个都是 null：观察器挂不上，也不会去读任何东西', () => {
    document.body.innerHTML = `
      <div class="position-list__abc123">
        <div class="positionCard__abc123"><span>楼宇工程</span></div>
      </div>
    `

    expect(getJdElement()).toBeNull()
    expect(getDetailPanel()).toBeNull()
    expect(readJdFromDom()).toBeNull()
  })
})

// eslint-disable-next-line test/prefer-lowercase-title
describe('DOM 兜底岗位（buildDomFallbackJob）', () => {
  it('没有已有数据时用 DOM 读到的标题与薪资', () => {
    mountPanel()

    const view = buildDomFallbackJob('JD 正文', TENANT, null, readJobOutlineFromDom(TENANT))

    expect(view.job.title).toBe('楼宇工程')
    expect(view.job.company).toBe('影视飓风')
    expect(view.job.salary).toBe('10-15K')
    expect(view.source).toBe('dom')
  })

  it('已有的接口数据优先于 DOM 新读到的值', () => {
    mountPanel()

    const view = buildDomFallbackJob(
      '展开后的完整 JD',
      TENANT,
      {
        job: { title: '接口岗位名', company: '影视飓风', salary: '20-30K' },
        site: { siteId: 'mediastorm', naturalKey: '7673106028406786331' },
      },
      readJobOutlineFromDom(TENANT),
    )

    expect(view.job.title).toBe('接口岗位名')
    expect(view.job.salary).toBe('20-30K')
    expect(view.site.naturalKey).toBe('7673106028406786331')
  })

  it('标题变了就不继承旧薪资（否则会把上一个岗位的薪资挂到当前岗位）', () => {
    mountPanel({ title: '另一个岗位', salary: '8-12K' })
    // 地址上是新岗位的标识 —— 这就是「另一个岗位」的判据（不是标题）
    vi.stubGlobal('location', { href: 'https://mediastorm.jobs.feishu.cn/index/position/1111111111111111111/detail' })

    const view = buildDomFallbackJob(
      '新岗位的 JD',
      TENANT,
      {
        job: { title: '接口岗位名', salary: '20-30K' },
        site: { siteId: 'mediastorm', naturalKey: '7673106028406786331' },
      },
      readJobOutlineFromDom(TENANT),
    )

    /*
     * 标题走共用骨架的兜底顺序（已有值 > DOM > 占位），所以这里仍是接口标题 ——
     * 与 BOSS / 电鸭 / V2EX 三家的 DOM 兜底行为一致，不在这里另立一套。
     * 关键断言是**薪资**：地址上的标识换了，旧薪资就不该跟过来。
     */
    expect(view.job.title).toBe('接口岗位名')
    expect(view.job.salary).toBe('8-12K')
  })

  it('同一个岗位时保留已有薪资（DOM 读不到薪资也不该把它抹掉）', () => {
    document.body.innerHTML = `
      <div class="jobDetail__f7613e jobDetail">
        <span data-test="jobTitle" class="job-title">楼宇工程</span>
        <div class="job-content__x"><div class="block-content">JD</div></div>
      </div>
    `
    vi.stubGlobal('location', { href: 'https://mediastorm.jobs.feishu.cn/index/position/7673106028406786331/detail' })

    const view = buildDomFallbackJob(
      'JD',
      TENANT,
      {
        job: { title: '楼宇工程', salary: '20-30K' },
        site: { siteId: 'mediastorm', naturalKey: '7673106028406786331' },
      },
      readJobOutlineFromDom(TENANT),
    )

    expect(view.job.salary).toBe('20-30K')
  })

  it('占位标题不算已有信息，会被 DOM 读到的标题覆盖', () => {
    mountPanel()

    const view = buildDomFallbackJob(
      'JD 正文',
      TENANT,
      { job: { title: '（未能从页面读取岗位信息）' }, site: { siteId: 'mediastorm', naturalKey: '' } },
      readJobOutlineFromDom(TENANT),
    )

    expect(view.job.title).toBe('楼宇工程')
  })

  it('读不到标题也没给标识时，共用骨架按内容定一个本地身份（账本键不会丢）', () => {
    document.body.innerHTML = '<div class="jobDetail__f7613e jobDetail"><div class="job-content__x"><div class="block-content">JD</div></div></div>'

    const view = buildDomFallbackJob('JD 正文', TENANT, null, readJobOutlineFromDom(TENANT))

    expect(view.job.title).toBe('（未能从页面读取岗位信息）')
    expect(view.site.naturalKey.startsWith('~')).toBe(true)
  })
})

describe('岗位标识（positionIdFromUrl）', () => {
  it('两种地址形态都认（直链与站内路由）', () => {
    expect(positionIdFromUrl('https://mediastorm.jobs.feishu.cn/index/position/7673106028406786331/detail')).toBe('7673106028406786331')
    expect(positionIdFromUrl('https://mediastorm.jobs.feishu.cn/position/detail/7673106028406786331')).toBe('7673106028406786331')
    expect(positionIdFromUrl('https://mediastorm.jobs.feishu.cn/index/position/7673106028406786331/detail?from=share')).toBe('7673106028406786331')
  })

  it('列表页与首页返回空串', () => {
    expect(positionIdFromUrl('https://mediastorm.jobs.feishu.cn/index/position')).toBe('')
    expect(positionIdFromUrl('https://mediastorm.jobs.feishu.cn/')).toBe('')
  })
})

describe('官网路径（websitePathFromUrl）', () => {
  it('取地址第一段（接口的 website-path 头就是它）', () => {
    expect(websitePathFromUrl('https://mediastorm.jobs.feishu.cn/index/position/1/detail', TENANT)).toBe('index')
  })

  it('站内路由形态（第一段是 position）退回租户配置里的 path', () => {
    expect(websitePathFromUrl('https://mediastorm.jobs.feishu.cn/position/detail/1', TENANT)).toBe('index')
    expect(websitePathFromUrl('https://mediastorm.jobs.feishu.cn/', TENANT)).toBe('index')
  })

  it('别的租户用自己配置的 path', () => {
    const campus: FeishuAtsTenant = {
      meta: { ...META, id: 'acme' },
      subdomain: 'acme',
      path: 'campus',
    }

    expect(websitePathFromUrl('https://acme.jobs.feishu.cn/position/detail/1', campus)).toBe('campus')
  })
})

describe('适配器契约', () => {
  it('主机名就是租户子域（不会放行整个 *.jobs.feishu.cn）', () => {
    expect(site.manifest.matches).toEqual(['*://mediastorm.jobs.feishu.cn/*'])
    expect(site.matchUrl('https://mediastorm.jobs.feishu.cn/index/position/1/detail')).toBe(true)
    // 别的租户不是我们的站点：放行它们等于申请了别人家的招聘页权限
    expect(site.matchUrl('https://acme.jobs.feishu.cn/index/position/1/detail')).toBe(false)
    expect(site.matchUrl('https://mediastorm.jobs.feishu.cn.evil.com/index/position/1/detail')).toBe(false)
  })

  it('岗位标识就是岗位身份：标识相同算同一岗位，标识变了就不是', () => {
    const existing = site.buildDomFallback('旧 JD', {
      site: site.emptyRef('7673106028406786331'),
    })

    try {
      vi.stubGlobal('location', { href: 'https://mediastorm.jobs.feishu.cn/index/position/7673106028406786331/detail' })
      // 同一个岗位：页面重渲染导致文本不同也仍然是同一岗位（身份以地址为准）
      expect(site.sameJob(existing, '旧 JD')).toBe(true)
      expect(site.sameJob(existing, '完全不同的 JD')).toBe(true)

      vi.stubGlobal('location', { href: 'https://mediastorm.jobs.feishu.cn/index/position/9999999999999999999/detail' })
      expect(site.sameJob(existing, '旧 JD')).toBe(false)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('地址上没有标识时退回文本比对（互相包含即同一岗位）', () => {
    const existing = site.buildDomFallback('完整的 JD 正文，包含职责与要求', {
      site: site.emptyRef(''),
    })

    try {
      vi.stubGlobal('location', { href: 'https://mediastorm.jobs.feishu.cn/index/position' })
      expect(site.sameJob(existing, '完整的 JD 正文')).toBe(true)
      expect(site.sameJob(existing, '另一个岗位的 JD')).toBe(false)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('诊断列出面板 / 标题 / 薪资 / 正文这些选择器', () => {
    mountPanel()

    const diag = site.diagnose()
    const keys = diag.selectors.map(s => s.key)

    expect(keys).toContain('详情面板')
    expect(keys).toContain('岗位名')
    expect(keys).toContain('薪资行')
    expect(diag.domOutline).toEqual({ jobName: '楼宇工程', brandName: '影视飓风' })
    expect(diag.jdLength).toBeGreaterThan(0)
  })
})
