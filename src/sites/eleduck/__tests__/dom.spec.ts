import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eleduckSite } from '..'
import { readJdFromDom, readJobOutlineFromDom } from '../dom'
import { isJobPostPage, postIdFromUrl, readPostTitle } from '../selectors'

/**
 * 电鸭社区适配器的 DOM 读取测试。
 *
 * 这个站点的岗位**只有** DOM 这一条取数路径（没有接口），所以这里的断言就是
 * 它的全部取数契约：能不能认出招聘帖、标题有没有摘掉分类名前缀、JD 是不是正文。
 *
 * 三类真机样本（标题行的实际 HTML 来自线上页面）：
 *  1. `/categories/5`「社区帖子招聘」—— 招聘
 *  2. `/categories/22`「精选职位推荐」（带一个图钉图标）—— 也是招聘
 *  3. `/categories/2`「分享」—— 普通交流帖，必须**不**被识别
 */

/** 按真机的标题行结构造一个帖子页 */
function mountPost(options: {
  categoryPath: string
  categoryName: string
  title: string
  body?: string
  /** 额外塞进标题行的装饰元素（如置顶图钉） */
  decoration?: string
}): void {
  document.body.innerHTML = `
    <h1 class="page-title">
      <a class="category-link mr-5" href="${options.categoryPath}">${options.categoryName}</a>
      ${options.title}
      ${options.decoration ?? ''}
    </h1>
    <div class="post-contents">${options.body ?? ''}</div>
  `
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('招聘帖识别（isJobPostPage）', () => {
  it('分类是 /categories/5「社区帖子招聘」→ 是招聘帖', () => {
    mountPost({ categoryPath: '/categories/5', categoryName: '社区帖子招聘', title: '【远程兼职】寻投手' })
    expect(isJobPostPage()).toBe(true)
  })

  it('分类是 /categories/22「精选职位推荐」→ 也是招聘帖', () => {
    mountPost({ categoryPath: '/categories/22', categoryName: '精选职位推荐', title: '【免费推荐/全职远程】Growth Lead' })
    expect(isJobPostPage()).toBe(true)
  })

  it('分类是 /categories/2「分享」→ 不是招聘帖', () => {
    mountPost({ categoryPath: '/categories/2', categoryName: '分享', title: '做了个浏览器插件帮我筛选工作' })
    expect(isJobPostPage()).toBe(false)
  })

  it('分类名被平台改名，但分类 id 仍是招聘分类 → 仍能认出（两条判据互为兜底）', () => {
    mountPost({ categoryPath: '/categories/5', categoryName: '社区帖子', title: '招人' })
    expect(isJobPostPage()).toBe(true)
  })

  it('分类 id 是新的，但分类名含「职位」→ 也能认出（新增招聘分类不用改代码）', () => {
    mountPost({ categoryPath: '/categories/31', categoryName: '远程职位速递', title: '招人' })
    expect(isJobPostPage()).toBe(true)
  })

  it('页面没有标题行（列表页 / 首页）→ 不是招聘帖', () => {
    document.body.innerHTML = '<div class="post-list">…</div>'
    expect(isJobPostPage()).toBe(false)
  })

  it('标题里的普通链接不算分类链接（判据只用 h1 的直接子元素）', () => {
    document.body.innerHTML = `
      <h1 class="page-title">
        <a href="/categories/2">分享</a>
        内推：<a href="/posts/abc123">某公司</a>
      </h1>
    `
    expect(isJobPostPage()).toBe(false)
  })
})

describe('标题读取（readPostTitle）', () => {
  it('摘掉分类名，只留帖子标题', () => {
    mountPost({
      categoryPath: '/categories/5',
      categoryName: '社区帖子招聘',
      title: '【远程兼职】香港持牌科技公司寻港台泛娱乐/社交产品专业买量投手（接受CPA/CPS对赌）',
    })

    expect(readPostTitle())
      .toBe('【远程兼职】香港持牌科技公司寻港台泛娱乐/社交产品专业买量投手（接受CPA/CPS对赌）')
  })

  it('分类名很长时也不会截错（按元素删，而不是按字符串前缀截）', () => {
    mountPost({
      categoryPath: '/categories/22',
      categoryName: '精选职位推荐',
      title: '【免费推荐/全职远程】年薪¥95W-150W/Growth Lead/AI Agent平台',
    })

    expect(readPostTitle()).toBe('【免费推荐/全职远程】年薪¥95W-150W/Growth Lead/AI Agent平台')
  })

  it('置顶图钉之类的装饰元素不进标题', () => {
    mountPost({
      categoryPath: '/categories/22',
      categoryName: '精选职位推荐',
      title: '后端工程师',
      decoration: '<span role="img" aria-label="pushpin" class="anticon anticon-pushpin"><svg><path d="M0 0" /></svg></span>',
    })

    expect(readPostTitle()).toBe('后端工程师')
  })

  it('没有标题行时返回空串（不抛错）', () => {
    expect(readPostTitle()).toBe('')
  })
})

describe('jD 读取（readJdFromDom）', () => {
  it('招聘帖返回正文全文，保留段落换行', () => {
    mountPost({
      categoryPath: '/categories/5',
      categoryName: '社区帖子招聘',
      title: '寻投手',
      body: `
        <p>一、项目及团队优势</p>
        <p>团队背景：香港正规持牌科技主体（澤錚有限公司）</p>
      `,
    })

    const jd = readJdFromDom()
    expect(jd).toContain('一、项目及团队优势')
    expect(jd).toContain('团队背景：香港正规持牌科技主体（澤錚有限公司）')
    // 段落之间必须留有换行：压成一行会让 AI 与阅读都丢掉结构
    expect(jd).toContain('\n')
  })

  it('非招聘帖返回 null（于是内容脚本不会产生任何岗位）', () => {
    mountPost({ categoryPath: '/categories/2', categoryName: '分享', title: '闲聊', body: '<p>正文</p>' })
    expect(readJdFromDom()).toBeNull()
  })

  it('招聘帖但正文为空时返回 null', () => {
    mountPost({ categoryPath: '/categories/5', categoryName: '社区帖子招聘', title: '招人' })
    expect(readJdFromDom()).toBeNull()
  })
})

describe('岗位名（readJobOutlineFromDom）', () => {
  it('招聘帖给出标题，公司名留空（电鸭帖子里是自由文本，不结构化提取）', () => {
    mountPost({ categoryPath: '/categories/5', categoryName: '社区帖子招聘', title: '寻投手' })

    expect(readJobOutlineFromDom()).toEqual({ jobName: '寻投手', brandName: '' })
  })

  it('非招聘帖一律空串', () => {
    mountPost({ categoryPath: '/categories/2', categoryName: '分享', title: '闲聊' })
    expect(readJobOutlineFromDom()).toEqual({ jobName: '', brandName: '' })
  })
})

describe('岗位标识（postIdFromUrl）', () => {
  it('从帖子地址里取 slug', () => {
    expect(postIdFromUrl('https://eleduck.com/posts/z1fRK7')).toBe('z1fRK7')
    expect(postIdFromUrl('https://eleduck.com/posts/z1fRK7?id=z1fRK7')).toBe('z1fRK7')
    expect(postIdFromUrl('https://eleduck.com/posts/z1fRK7#comment-1')).toBe('z1fRK7')
  })

  it('非帖子地址返回空串（列表页、首页）', () => {
    expect(postIdFromUrl('https://eleduck.com/jobs-channel')).toBe('')
    expect(postIdFromUrl('https://eleduck.com/')).toBe('')
  })
})

describe('适配器契约', () => {
  it('是只读 DOM 的站点：不声明任何要捕获的接口', () => {
    expect(eleduckSite.source).toBe('dom')
    expect(eleduckSite.manifest.watchedApiPaths).toEqual([])
  })

  it('dOM 兜底造出的岗位带本站点身份与 URL 上的 slug', () => {
    const view = eleduckSite.buildDomFallback('JD 正文', {
      site: eleduckSite.emptyRef('z1fRK7'),
    }, { jobName: '寻投手', brandName: '' })

    expect(view.site).toEqual({ siteId: 'eleduck', naturalKey: 'z1fRK7' })
    expect(view.job.title).toBe('寻投手')
    expect(view.jdText).toBe('JD 正文')
    expect(view.source).toBe('dom')
  })

  it('帖子地址里的 slug 就是岗位身份：slug 相同算同一岗位，slug 变了就不是', () => {
    const existing = eleduckSite.buildDomFallback('旧 JD', { site: eleduckSite.emptyRef('z1fRK7') })

    try {
      // jsdom 里 window.location 是 about:blank，这里换成真实的帖子地址
      vi.stubGlobal('location', { href: 'https://eleduck.com/posts/z1fRK7' })
      // 同一个帖子：即使读到的是另一段文本（页面重渲染/截断）也仍然是同一岗位 ——
      // 身份以 URL 为准，不然每刷新一次就会被当成新岗位
      expect(eleduckSite.sameJob(existing, '旧 JD')).toBe(true)
      expect(eleduckSite.sameJob(existing, '完全不同的 JD')).toBe(true)

      vi.stubGlobal('location', { href: 'https://eleduck.com/posts/OTHER99' })
      expect(eleduckSite.sameJob(existing, '旧 JD')).toBe(false)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('uRL 上没有 slug 时退回文本比对（互相包含即同一岗位）', () => {
    const existing = eleduckSite.buildDomFallback('完整的 JD 正文，包含职责与要求', {
      site: eleduckSite.emptyRef(''),
    })

    try {
      vi.stubGlobal('location', { href: 'https://eleduck.com/jobs-channel' })
      expect(eleduckSite.sameJob(existing, '完整的 JD 正文')).toBe(true)
      expect(eleduckSite.sameJob(existing, '另一个帖子的 JD')).toBe(false)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
