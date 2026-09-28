import type { JobCore, JobView } from '~/logic/types'
import { describe, expect, it } from 'vitest'
import { createEmptyJobView } from '~/logic/types'
import { buildDomFallbackView, preferText } from '../dom-fallback'

/**
 * DOM 兜底骨架的测试。
 *
 * 这个骨架存在的意义就是把两个站点共同的三条不变量收在一处，因此这里钉的就是
 * 那三条：**标题兜底顺序**、**站点身份（含私有 id 与兜底身份）**、**来源标记**。
 * 各站点的差异（继承谁、清谁）不在这里测 —— 那是两个站点自己的 spec 的事。
 */

/** 造一个「站点自己的 job 拼装」，只带标题，和电鸭的形态一致 */
function titleOnlyJob(title: string, baseJob: JobCore | undefined): JobCore {
  return { title, company: title === baseJob?.title ? baseJob?.company : undefined }
}

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
