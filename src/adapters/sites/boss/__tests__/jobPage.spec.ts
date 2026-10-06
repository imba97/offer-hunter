import { describe, expect, it } from 'vitest'
import bossSite from '../index'

/**
 * BOSS 的岗位页判定（适配器的 `isJobPage`）。
 *
 * 这一支守的是「面板该不该显示岗位」这条硬门槛，两种判错都有真机症状：
 *  - 判成非岗位页 → 面板空着（用户看不到岗位）
 *  - 判成岗位页 → 面板显示一个用户已经不在看的岗位（沟通页显示上一个岗位）
 *
 * BOSS 的特殊之处在于**同一个地址可能是两种页面**：
 * `/job_detail/<id>.html` 既是独立职位详情页，也可能是列表页点卡片后留在原页的
 * 右侧面板。两者只能靠页面渲染出来的东西区分，因此这里把两种情形都钉住。
 */

/** 列表 / 搜索页右侧那套详情面板（真机结构） */
function mountListPanel(jd: string): void {
  document.body.innerHTML = `
    <div class="job-detail-box">
      <h1 class="job-name">高级后端工程师</h1>
      <span class="company-name">某某科技</span>
      <div class="job-detail-body"><div class="desc"><p>${jd}</p></div></div>
    </div>
  `
}

/** 独立职位详情页：没有 `.job-detail-box`，结构与列表页那套完全不同 */
function mountStandaloneDetailPage(): void {
  document.body.innerHTML = `
    <div class="job-detail">
      <div class="boss-info">许建云 刚刚活跃</div>
      <div class="company-info"><span class="name">某某科技有限公司</span></div>
      <div class="job-detail-section"><div class="job-sec-text">岗位职责：写代码</div></div>
    </div>
  `
}

const LIST_URL = 'https://www.zhipin.com/web/geek/jobs'
const SEARCH_URL = 'https://www.zhipin.com/web/geek/job?query=Java&city=101020100'
const DETAIL_URL = 'https://www.zhipin.com/job_detail/e2305163cf88e8420nN93NS0GFVT.html'
const CHAT_URL = 'https://www.zhipin.com/web/geek/chat'

describe('boss isJobPage', () => {
  it('列表 / 搜索页恒为岗位页（不依赖面板渲染出来了没有）', () => {
    document.body.innerHTML = ''

    // 面板还在加载时也得认：否则那一瞬间捕到的详情响应会被当成非岗位页的数据丢掉
    expect(bossSite.isJobPage(LIST_URL)).toBe(true)
    expect(bossSite.isJobPage(SEARCH_URL)).toBe(true)
  })

  it('独立职位详情页不是岗位页（那页的 DOM 读出来的东西对不上真岗位）', () => {
    mountStandaloneDetailPage()

    expect(bossSite.isJobPage(DETAIL_URL)).toBe(false)
  })

  it('详情地址上渲染着列表页那套面板时仍算岗位页（两栏列表就是这种形态）', () => {
    mountListPanel('岗位职责：写代码')

    expect(bossSite.isJobPage(DETAIL_URL)).toBe(true)
  })

  it('面板存在但还没读出正文时不算（宁可晚一轮，也不要显示错的东西）', () => {
    // 面板的骨架渲染出来了，正文还是空的
    document.body.innerHTML = '<div class="job-detail-box"><div class="job-detail-body"><div class="desc"></div></div></div>'

    expect(bossSite.isJobPage(DETAIL_URL)).toBe(false)
  })

  it('沟通页 / 简历页 / 公司页都不是岗位页', () => {
    document.body.innerHTML = ''

    expect(bossSite.isJobPage(CHAT_URL)).toBe(false)
    expect(bossSite.isJobPage(`${CHAT_URL}#/chat/123`)).toBe(false)
    expect(bossSite.isJobPage('https://www.zhipin.com/web/user/?ka=header-login')).toBe(false)
    expect(bossSite.isJobPage('https://www.zhipin.com/gongsi/abc~.html')).toBe(false)
  })

  it('沟通页上即使残留着旧详情面板也不算岗位页（URL 先否决）', () => {
    // SPA 常把上一个页面的 DOM 保活着（只是隐藏），正文仍然读得出来
    mountListPanel('上一个岗位的 JD')

    expect(bossSite.isJobPage(CHAT_URL)).toBe(false)
  })

  it('地址不可解析时不是岗位页', () => {
    expect(bossSite.isJobPage('about:blank')).toBe(false)
    expect(bossSite.isJobPage('')).toBe(false)
  })
})
