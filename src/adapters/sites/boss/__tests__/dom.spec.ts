import { describe, expect, it } from 'vitest'
import { buildDomFallbackJob, EMPTY_JOB_NAME, readJdFromDom, readJobOutlineFromDom } from '../dom'

/**
 * DOM 兜底岗位的单测。
 *
 * 重点是两个容易出错的地方：
 *  1. 岗位名/公司名靠「class 关键词 + 长度上限」从详情容器里捞 —— 不能把整段
 *     公司介绍当成公司名（真机命中情况由诊断面板复验）
 *  2. 合并顺序：接口数据 > DOM 新读到的 > 占位符；但「占位标题」不算已有信息
 */

function mountBox(inner: string): void {
  document.body.innerHTML = `<div class="job-detail-box">${inner}</div>`
}

describe('readJobOutlineFromDom', () => {
  it('从详情容器里读出岗位名与公司名', () => {
    mountBox(`
      <div class="job-primary">
        <h1 class="job-name">高级后端工程师</h1>
        <span class="company-name">某某科技有限公司</span>
      </div>
      <div class="job-detail-body"><div class="desc"><p>岗位职责：写代码</p></div></div>
    `)

    expect(readJobOutlineFromDom()).toEqual({
      jobName: '高级后端工程师',
      brandName: '某某科技有限公司',
    })
  })

  it('没有 h1 时退回 class 关键词命中', () => {
    mountBox(`
      <div class="job-title">数据分析师</div>
      <div class="brand-name">另一家公司</div>
    `)

    expect(readJobOutlineFromDom()).toEqual({
      jobName: '数据分析师',
      brandName: '另一家公司',
    })
  })

  it('过长文本不算名字（避免把整段公司介绍当公司名）', () => {
    mountBox(`
      <div class="company-name">${'这是一家很大的公司，'.repeat(10)}</div>
      <div class="job-name">前端工程师</div>
    `)

    const outline = readJobOutlineFromDom()
    expect(outline.brandName).toBe('')
    expect(outline.jobName).toBe('前端工程师')
  })

  it('详情容器还没渲染时返回空串', () => {
    document.body.innerHTML = '<div>别的页面</div>'
    expect(readJobOutlineFromDom()).toEqual({ jobName: '', brandName: '' })
  })
})

/**
 * 独立职位详情页（`/job_detail/<encryptJobId>.html`）**有意不读**。
 *
 * 那一页与列表页右侧面板不是一套 DOM：招聘者、公司信息与正文混在 `.job-detail` 里，
 * 按「短文本 + class 关键词」硬读会读出招聘者与公司信息（真机读到过
 * 「许建云 刚刚活跃」这种值 —— 面板显示出一份看起来像岗位、字段却全部错位的东西）。
 *
 * 因此产品结论是**详情页不展示岗位**（由适配器的 isJobPage 排除），这条用例只钉住
 * 「读不出来」这件事本身：谁要是想再给详情页加选择器，会先看到这里的理由。
 */
describe('独立职位详情页（有意不读）', () => {
  it('详情页那套 DOM 读不出正文与名字', () => {
    document.body.innerHTML = `
      <div class="job-detail">
        <div class="boss-info">许建云 刚刚活跃</div>
        <div class="company-info"><span class="name">杭州淘金数科技有限公司</span></div>
        <div class="job-detail-section"><div class="job-sec-text">岗位职责：写代码</div></div>
      </div>
    `

    expect(readJdFromDom()).toBeNull()
    expect(readJobOutlineFromDom()).toEqual({ jobName: '', brandName: '' })
  })
})

describe('buildDomFallbackJob', () => {
  const outline = { jobName: '高级后端工程师', brandName: '某某科技' }

  it('没有已有数据时用 DOM 读到的名字，来源标为 dom', () => {
    const job = buildDomFallbackJob('JD 正文', null, outline)

    expect(job.job.title).toBe('高级后端工程师')
    expect(job.job.company).toBe('某某科技')
    expect(job.jdText).toBe('JD 正文')
    expect(job.source).toBe('dom')
    expect(job.capturedAt).not.toBe('')
  })

  it('dom 里也没读到名字时退回占位标题', () => {
    const job = buildDomFallbackJob(
      'JD 正文',
      { site: { siteId: 'boss', naturalKey: 'sid-1' } },
      { jobName: '', brandName: '' },
    )

    expect(job.job.title).toBe(EMPTY_JOB_NAME)
    expect(job.job.company).toBeUndefined()
    expect(job.site.naturalKey).toBe('sid-1')
  })

  it('已有的接口数据优先于 DOM 新读到的值', () => {
    const job = buildDomFallbackJob(
      '展开后的完整 JD',
      {
        job: { title: '接口岗位名', company: '接口公司名', salary: '25-40K' },
        site: { siteId: 'boss', naturalKey: 'sid-1' },
      },
      outline,
    )

    expect(job.job.title).toBe('接口岗位名')
    expect(job.job.company).toBe('接口公司名')
    expect(job.job.salary).toBe('25-40K')
    expect(job.jdText).toBe('展开后的完整 JD')
  })

  it('占位标题不算已有信息，会被 DOM 读到的名字覆盖', () => {
    const job = buildDomFallbackJob(
      'JD 正文',
      { job: { title: EMPTY_JOB_NAME }, site: { siteId: 'boss', naturalKey: 'sid-1' } },
      outline,
    )

    expect(job.job.title).toBe('高级后端工程师')
  })

  it('不继承 base 里的招聘者（否则会把上一个岗位的 HR 挂到当前岗位）', () => {
    const job = buildDomFallbackJob(
      'JD 正文',
      {
        job: {
          title: '接口岗位',
          company: '接口公司',
          recruiter: { name: '接口岗位的 HR', title: '招聘主管', online: true },
        },
        site: { siteId: 'boss', naturalKey: 'sid-1' },
      },
      outline,
    )

    expect(job.job.recruiter).toBeUndefined()
  })
})
