import type { JobCore, JobView } from '~/logic/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyJobView } from '~/logic/types'
import { buildDomFallbackView, preferText, sameJobFromUrl, titleOnlyJob } from '../dom-fallback'

/**
 * DOM 兜底骨架的测试。
 *
 * 这个骨架存在的意义就是把各站点共同的不变量收在一处，因此这里钉的就是它们：
 * **标题兜底顺序**、**站点身份（含私有 id 与兜底身份）**、**来源标记**、
 * **`job` 回调的标题/公司名继承规则**、**「同一岗位」判据**。
 * 各站点的差异（继承谁、清谁）不在这里测 —— 那是各站点自己的 spec 的事。
 */

function build(patch: Partial<Parameters<typeof buildDomFallbackView>[0]> = {}): JobView {
  return buildDomFallbackView({
    siteId: 'boss',
    emptyTitle: '（未读到标题）',
    jdText: 'JD 正文',
    job: titleOnlyJob,
    ...patch,
  })
}

describe('preferText', () => {
  it('已有值优先于 DOM 新读到的', () => {
    expect(preferText({ current: '已有标题', fromDom: 'DOM 标题' })).toBe('已有标题')
  })

  it('已有值缺失时用 DOM 读到的', () => {
    expect(preferText({ fromDom: 'DOM 标题', fallback: '占位' })).toBe('DOM 标题')
  })

  it('两边都没有时用 fallback', () => {
    expect(preferText({ fromDom: '', fallback: '占位' })).toBe('占位')
  })

  it('已有值等于占位文案时不算「已有」（否则占位会被一直传下去）', () => {
    expect(preferText({ current: '占位', fromDom: 'DOM 标题', fallback: '占位', placeholder: '占位' }))
      .toBe('DOM 标题')
  })

  it('不传 placeholder 时不做占位判断（公司名那种用不上这条规则的场景）', () => {
    expect(preferText({ current: '占位', fromDom: 'DOM 公司' })).toBe('占位')
  })

  it('什么都不传时返回空串', () => {
    expect(preferText({})).toBe('')
  })
})

describe('buildDomFallbackView', () => {
  it('标题走兜底顺序，job 由站点自己拼', () => {
    const view = build({ outline: { jobName: '资深后端工程师', brandName: '某某科技' } })

    expect(view.job.title).toBe('资深后端工程师')
    expect(view.jdText).toBe('JD 正文')
    expect(view.source).toBe('dom')
    expect(view.capturedAt).not.toBe('')
  })

  it('读不到标题时用本站点的占位文案', () => {
    expect(build({ outline: { jobName: '', brandName: '' } }).job.title).toBe('（未读到标题）')
    expect(build().job.title).toBe('（未读到标题）')
  })

  it('沿用 base 里的站点身份，包括接口给的私有 id 与原始响应', () => {
    const view = build({
      base: {
        site: {
          siteId: 'boss',
          naturalKey: 'sid-1',
          ids: { encryptJobId: 'enc-1' },
          raw: { code: 0 },
        },
      },
      outline: { jobName: '标题', brandName: '' },
    })

    expect(view.site.siteId).toBe('boss')
    expect(view.site.naturalKey).toBe('sid-1')
    // 站点私有数据上层不读，但也不能在兜底路径上被抹掉（将来深链/刷新要用）
    expect(view.site.ids).toEqual({ encryptJobId: 'enc-1' })
    expect(view.site.raw).toEqual({ code: 0 })
  })

  it('站点给不出标识时按岗位内容定一个本地身份', () => {
    const view = build({
      base: { site: { siteId: 'boss', naturalKey: '' } },
      outline: { jobName: '资深后端工程师', brandName: '' },
    })

    expect(view.site.naturalKey).toMatch(/^~[0-9a-f]{16}$/)
  })

  it('内容不同则兜底身份不同（否则两个岗位会串分析结果）', () => {
    const a = build({ jdText: '岗位职责：写代码', outline: { jobName: '后端', brandName: '' } })
    const b = build({ jdText: '岗位职责：做设计', outline: { jobName: '后端', brandName: '' } })

    expect(a.site.naturalKey).not.toBe(b.site.naturalKey)
  })

  it('用入参里的 siteId，而不是写死某一家', () => {
    const view = build({ siteId: 'eleduck', job: title => ({ title }) })

    expect(view.site.siteId).toBe('eleduck')
    expect(view.site.naturalKey).toMatch(/^~[0-9a-f]{16}$/)
  })

  it('base 里的 title 优先，且占位标题不算已有信息', () => {
    const fromApi = build({
      base: { job: { title: '接口标题' }, site: { siteId: 'boss', naturalKey: 'sid-1' } },
      outline: { jobName: 'DOM 标题', brandName: '' },
    })
    expect(fromApi.job.title).toBe('接口标题')

    const fromPlaceholder = build({
      base: { job: { title: '（未读到标题）' }, site: { siteId: 'boss', naturalKey: 'sid-1' } },
      outline: { jobName: 'DOM 标题', brandName: '' },
    })
    expect(fromPlaceholder.job.title).toBe('DOM 标题')
  })

  it('空入参也能造出良构视图（不抛错）', () => {
    const view = buildDomFallbackView({
      siteId: 'boss',
      emptyTitle: '（未读到标题）',
      jdText: '',
      job: titleOnlyJob,
    })

    expect(view.jdText).toBe('')
    expect(view.site.naturalKey).toMatch(/^~[0-9a-f]{16}$/)
    expect(view.source).toBe('dom')
  })

  it('不修改传进来的 base', () => {
    const base = { job: { title: '接口标题' }, site: { siteId: 'boss', naturalKey: '' } }
    const snapshot = JSON.parse(JSON.stringify(base))
    const view = build({ base })

    expect(base).toEqual(snapshot)
    // 视图里的身份是新算的，不该写回调用方的 base
    expect(view.site.naturalKey).toMatch(/^~[0-9a-f]{16}$/)
  })
})

describe('骨架与 createEmptyJobView 的关系', () => {
  it('未覆盖的字段仍由 createEmptyJobView 提供默认值', () => {
    const view = build()
    const empty = createEmptyJobView()

    expect(Object.keys(view).sort()).toEqual(Object.keys(empty).sort())
  })
})

/**
 * `titleOnlyJob` 是「只给得出标题」的站点（电鸭、V2EX）共用的 `job` 回调。
 *
 * 这里钉的是那条不变量：**标题变了就不继承公司名**。它不是可有可无的清理 ——
 * 用户点开另一个帖子而 base 里还留着上一个帖子的公司名时，张冠李戴会直接显示在
 * 面板上（两个站点此前各有一份逐字相同的实现，行为只被各自的 spec 间接覆盖）。
 */
describe('titleOnlyJob（只给得出标题的站点的 job 回调）', () => {
  it('只带标题，不带薪资/地点等结构化字段', () => {
    expect(titleOnlyJob('某岗位', undefined)).toEqual({ title: '某岗位', company: undefined })
  })

  it('标题没变时继承 base 里的公司名（同一岗位的重新读取）', () => {
    const base = { title: '某岗位', company: '某公司', salary: '20k' } as JobCore
    const job = titleOnlyJob('某岗位', base)

    expect(job.company).toBe('某公司')
    // 薪资这类字段不属于这个形状：只挑标题与公司，不整个 {...base}
    expect(job).toEqual({ title: '某岗位', company: '某公司' })
  })

  it('标题变了就不继承公司名（换了一个帖子，base 属于上一个岗位）', () => {
    const base = { title: '上一个岗位', company: '上一个公司' } as JobCore

    expect(titleOnlyJob('新岗位', base).company).toBeUndefined()
  })

  it('base 里公司名本来就是空的时，继承到的仍是 undefined（「没有」只有一种表示）', () => {
    const job = titleOnlyJob('某岗位', { title: '某岗位' } as JobCore)

    expect(job.company).toBeUndefined()
  })
})

/**
 * `sameJobFromUrl` 是「地址里带稳定标识」的站点（电鸭 `/posts/<slug>`、V2EX `/t/<id>`）
 * 共用的判据，此前两个站点各写了一份逐字相同的实现。
 *
 * 顺序是有意义的：**标识优先于文本**。用文本优先会让同一个帖子在重渲染或被截断后
 * 换一个身份，于是账本里攒出多条记录、刚分析过的结果查不回来（真实故障）。
 */
describe('sameJobFromUrl（地址里带稳定标识的站点的同一岗位判据）', () => {
  /** 造一个「从 /t/<id> 取标识」的站点读取函数，模拟 V2EX 的形态 */
  const keyFromUrl = (url: string): string => /\/t\/(\d+)/.exec(url)?.[1] ?? ''

  function view(site: { siteId: string, naturalKey: string }, jdText: string): JobView {
    return createEmptyJobView({ site, jdText })
  }

  function withLocation(href: string, run: () => void): void {
    vi.stubGlobal('location', { href })
    try {
      run()
    }
    finally {
      vi.unstubAllGlobals()
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('地址上的标识相同 → 同一岗位（哪怕文本完全不同）', () => {
    withLocation('https://www.v2ex.com/t/1245478', () => {
      const existing = view({ siteId: 'v2ex', naturalKey: '1245478' }, '旧 JD')
      expect(sameJobFromUrl(keyFromUrl, existing, '完全不同的 JD')).toBe(true)
    })
  })

  it('地址上的标识不同 → 不是同一岗位（哪怕文本一模一样）', () => {
    withLocation('https://www.v2ex.com/t/9999999', () => {
      const existing = view({ siteId: 'v2ex', naturalKey: '1245478' }, '一样的 JD')
      expect(sameJobFromUrl(keyFromUrl, existing, '一样的 JD')).toBe(false)
    })
  })

  it('地址上拿不到标识时退回文本比对：互相包含即同一岗位', () => {
    withLocation('https://www.v2ex.com/go/jobs', () => {
      const full = '完整的 JD 正文，包含职责与要求'
      const existing = view({ siteId: 'v2ex', naturalKey: '' }, full)

      // 两个方向都算同一岗位：DOM 读到的往往是截断版（页面折叠/增量渲染），
      // 也可能反过来比已有文本更全（先兜底读了摘要、后续渲染出全文）。
      expect(sameJobFromUrl(keyFromUrl, existing, '完整的 JD 正文')).toBe(true)
      expect(sameJobFromUrl(keyFromUrl, existing, `${full}，还追加了一段`)).toBe(true)

      // ⚠ 但「互相包含」只在有包含关系时成立：两段各有独立内容的文本是不同岗位
      expect(sameJobFromUrl(keyFromUrl, existing, '另一段完全不同的 JD 正文，包含职责与要求啊')).toBe(false)
      expect(sameJobFromUrl(keyFromUrl, existing, '另一个帖子的 JD')).toBe(false)
    })
  })

  it('地址上拿不到标识、已有 JD 又是空的 → 视为同一岗位（没有依据说它变了）', () => {
    withLocation('https://www.v2ex.com/go/jobs', () => {
      const existing = view({ siteId: 'v2ex', naturalKey: '' }, '')
      expect(sameJobFromUrl(keyFromUrl, existing, '任意文本')).toBe(true)
    })
  })
})
