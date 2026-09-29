import { beforeEach, describe, expect, it, vi } from 'vitest'
import { v2exSite } from '..'
import { readJdFromDom, readJobOutlineFromDom } from '../dom'
import { isJobPostPage, readTopicTitle, topicIdFromUrl } from '../selectors'

/**
 * V2EX 适配器的 DOM 读取测试。
 *
 * 这个站点的岗位**只有** DOM 这一条取数路径（没有接口），所以这里的断言就是
 * 它的全部取数契约：能不能认出「酷工作」节点下的帖子、标题对不对、JD 是不是正文。
 *
 * 四类真机样本（结构均照抄线上页面）：
 *  1. `/t/1245478` —— 招聘帖，节点「酷工作」（`/go/jobs`）→ 是岗位
 *  2. `/t/1151259` —— 也是招聘帖，但节点是「远程工作」（`/go/remote`）→ **不是**
 *  3. `/go/jobs` —— 节点列表页（侧栏里也有 `/go/jobs` 链接）→ **不是**
 *  4. 非招聘话题 → **不是**
 */

/**
 * 造一个主题页。
 *
 * `nodePath` 是节点头部里那条链接的目标 —— 它就是「这一页属不属于酷工作」的
 * 全部依据（对应真机里 V2EX › 酷工作 那条面包屑）。
 */
function mountTopic(options: {
  nodePath: string
  nodeName: string
  title: string
  body?: string
}): void {
  document.body.innerHTML = `
    <div id="Main">
      <div class="box">
        <div class="header">
          <div class="fr"><a href="/member/guozozo"><img class="avatar" /></a></div>
          <div class="flex-one-row gap10">
            <div><a href="/">V2EX</a> <span class="chevron">&nbsp;›&nbsp;</span> <a href="${options.nodePath}">${options.nodeName}</a></div>
          </div>
          <div class="sep10"></div>
          <h1>${options.title}</h1>
          <div class="votes"><a href="javascript:" class="vote"></a></div>
          <small class="gray"><a href="/member/guozozo">guozozo</a> · 441 views</small>
        </div>
        <div class="cell">
          <div class="topic_content">${options.body ?? ''}</div>
        </div>
      </div>
    </div>
  `
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('工作帖识别（isJobPostPage）', () => {
  it('节点是 /go/jobs「酷工作」→ 是工作帖', () => {
    mountTopic({ nodePath: '/go/jobs', nodeName: '酷工作', title: '[招聘]: 医疗器械软件工程师' })
    expect(isJobPostPage()).toBe(true)
  })

  it('招聘帖但节点是 /go/remote「远程工作」→ 不是工作帖（只认酷工作节点）', () => {
    mountTopic({ nodePath: '/go/remote', nodeName: '远程工作', title: '招聘（远程办公-web3）' })
    expect(isJobPostPage()).toBe(false)
  })

  it('节点列表页 /go/jobs：侧栏虽有 /go/jobs 链接，但没有标题行 → 不是工作帖', () => {
    // 真机的列表页结构：节点头部用的是别的类名（node-header），页面没有 h1
    document.body.innerHTML = `
      <div id="Main">
        <div class="box box-title node-header">
          <div class="cell page-content-header">
            <div class="title"><div class="node-breadcrumb"><a href="/">V2EX</a> › 酷工作</div></div>
          </div>
        </div>
        <div id="Sidebar"><a href="/go/jobs">酷工作</a></div>
      </div>
    `
    expect(isJobPostPage()).toBe(false)
  })

  it('别的节点下的普通话题（节点链接形似但不同）→ 不是工作帖', () => {
    mountTopic({ nodePath: '/go/jobs-salary', nodeName: '酷工作薪资', title: '聊聊薪资' })
    expect(isJobPostPage()).toBe(false)
  })

  it('首页等没有节点头部的页面 → 不是工作帖', () => {
    document.body.innerHTML = '<div id="Main"><div class="cell">…</div></div>'
    expect(isJobPostPage()).toBe(false)
  })

  it('判据是精确的 href，不是链接文字（节点改名不影响识别）', () => {
    mountTopic({ nodePath: '/go/jobs', nodeName: '招聘求职', title: '招人' })
    expect(isJobPostPage()).toBe(true)
  })
})

describe('标题读取（readTopicTitle）', () => {
  it('读标题行全文', () => {
    mountTopic({
      nodePath: '/go/jobs',
      nodeName: '酷工作',
      title: '[招聘]: 医疗器械软件工程师， C++/Qt，桌面应用开发，上海，薪资面议',
    })

    expect(readTopicTitle()).toBe('[招聘]: 医疗器械软件工程师， C++/Qt，桌面应用开发，上海，薪资面议')
  })

  it('标题里的真换行压成空格（真机 /t/1151259 的标题是多行的）', () => {
    mountTopic({
      nodePath: '/go/jobs',
      nodeName: '酷工作',
      title: '招聘（远程办公-web3）\nGolang 工程师\n前端工程师（Nodejs / React）',
    })

    expect(readTopicTitle()).toBe('招聘（远程办公-web3） Golang 工程师 前端工程师（Nodejs / React）')
  })

  it('没有标题行时返回空串（不抛错）', () => {
    expect(readTopicTitle()).toBe('')
  })
})

describe('jD 读取（readJdFromDom）', () => {
  it('工作帖返回正文全文', () => {
    mountTopic({
      nodePath: '/go/jobs',
      nodeName: '酷工作',
      title: '[招聘]: 医疗器械软件工程师',
      body: '岗位职责：<br />1.负责医疗器械软件平台及基础框架开发与维护。<br /><br />任职要求：<br />1.本科及以上学历。',
    })

    const jd = readJdFromDom()
    expect(jd).toContain('岗位职责：')
    expect(jd).toContain('1.负责医疗器械软件平台及基础框架开发与维护。')
    expect(jd).toContain('任职要求：')
    expect(jd).toContain('1.本科及以上学历。')
  })

  it('非酷工作节点的帖子返回 null（于是内容脚本不会产生任何岗位）', () => {
    mountTopic({
      nodePath: '/go/remote',
      nodeName: '远程工作',
      title: '招聘（远程办公-web3）',
      body: '岗位职责：…',
    })
    expect(readJdFromDom()).toBeNull()
  })

  it('工作帖但正文为空时返回 null', () => {
    mountTopic({ nodePath: '/go/jobs', nodeName: '酷工作', title: '招人' })
    expect(readJdFromDom()).toBeNull()
  })

  it('正文里的零宽字符被清掉（V2EX 的编辑器会插零宽字符）', () => {
    mountTopic({
      nodePath: '/go/jobs',
      nodeName: '酷工作',
      title: '招人',
      body: '第一段\u200B<br />第二段',
    })

    /*
     * ⚠ 这里不断言换行：jsdom 不实现 `innerText`，读到的是 textContent 兜底路径，
     *   而它**不会**为 `<br>` 生成换行（真实浏览器走 innerText，段落结构在那边）。
     *   单测能覆盖的是「零宽字符被去掉、行被归一化」这一段共享逻辑。
     */
    expect(readJdFromDom()).toBe('第一段第二段')
    expect(readJdFromDom()).not.toContain('\u200B')
  })
})

describe('岗位名（readJobOutlineFromDom）', () => {
  it('工作帖给出标题，公司名留空（帖子里是自由文本，不结构化提取）', () => {
    mountTopic({ nodePath: '/go/jobs', nodeName: '酷工作', title: '[招聘]: 医疗器械软件工程师' })

    expect(readJobOutlineFromDom()).toEqual({ jobName: '[招聘]: 医疗器械软件工程师', brandName: '' })
  })

  it('非工作帖一律空串', () => {
    mountTopic({ nodePath: '/go/remote', nodeName: '远程工作', title: '招聘（远程办公-web3）' })
    expect(readJobOutlineFromDom()).toEqual({ jobName: '', brandName: '' })
  })
})

describe('岗位标识（topicIdFromUrl）', () => {
  it('从主题地址里取帖子 id', () => {
    expect(topicIdFromUrl('https://www.v2ex.com/t/1245478')).toBe('1245478')
    expect(topicIdFromUrl('https://www.v2ex.com/t/1245478#reply3')).toBe('1245478')
    expect(topicIdFromUrl('https://global.v2ex.co/t/1245478')).toBe('1245478')
  })

  it('非主题地址返回空串（列表页、首页）', () => {
    expect(topicIdFromUrl('https://www.v2ex.com/go/jobs')).toBe('')
    expect(topicIdFromUrl('https://www.v2ex.com/')).toBe('')
    expect(topicIdFromUrl('https://www.v2ex.com/member/guozozo')).toBe('')
  })
})

describe('适配器契约', () => {
  it('是只读 DOM 的站点：不声明任何要捕获的接口', () => {
    expect(v2exSite.source).toBe('dom')
    expect(v2exSite.manifest.watchedApiPaths).toEqual([])
  })

  it('dOM 兜底造出的岗位带本站点身份与 URL 上的帖子 id', () => {
    const view = v2exSite.buildDomFallback('JD 正文', {
      site: v2exSite.emptyRef('1245478'),
    }, { jobName: '[招聘]: 医疗器械软件工程师', brandName: '' })

    expect(view.site).toEqual({ siteId: 'v2ex', naturalKey: '1245478' })
    expect(view.job.title).toBe('[招聘]: 医疗器械软件工程师')
    expect(view.jdText).toBe('JD 正文')
    expect(view.source).toBe('dom')
  })

  it('帖子 id 就是岗位身份：id 相同算同一岗位，id 变了就不是', () => {
    const existing = v2exSite.buildDomFallback('旧 JD', { site: v2exSite.emptyRef('1245478') })

    try {
      // jsdom 里 window.location 是 about:blank，这里换成真实的主题地址
      vi.stubGlobal('location', { href: 'https://www.v2ex.com/t/1245478' })
      // 同一个帖子：即使读到的是另一段文本（页面重渲染/截断）也仍然是同一岗位 ——
      // 身份以 URL 为准，不然每刷新一次就会被当成新岗位
      expect(v2exSite.sameJob(existing, '旧 JD')).toBe(true)
      expect(v2exSite.sameJob(existing, '完全不同的 JD')).toBe(true)

      vi.stubGlobal('location', { href: 'https://www.v2ex.com/t/9999999' })
      expect(v2exSite.sameJob(existing, '旧 JD')).toBe(false)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('uRL 上没有帖子 id 时退回文本比对（互相包含即同一岗位）', () => {
    const existing = v2exSite.buildDomFallback('完整的 JD 正文，包含职责与要求', {
      site: v2exSite.emptyRef(''),
    })

    try {
      vi.stubGlobal('location', { href: 'https://www.v2ex.com/go/jobs' })
      expect(v2exSite.sameJob(existing, '完整的 JD 正文')).toBe(true)
      expect(v2exSite.sameJob(existing, '另一个帖子的 JD')).toBe(false)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('观察器容器按契约只回答「容器在不在」，判定留给 readJd（非工作帖照样能挂上）', () => {
    mountTopic({ nodePath: '/go/remote', nodeName: '远程工作', title: '随便聊聊', body: '正文' })
    // 容器拿得到 —— 判定不在容器选择器里，否则非工作帖会陷入 500ms 的挂载重试
    expect(v2exSite.jdProbeElement()).not.toBeNull()
    expect(v2exSite.jdContainerElement()).not.toBeNull()
    // 但内容脚本不会因此产生岗位：读取这一步被判定挡住
    expect(v2exSite.readJd()).toBeNull()
  })

  it('列表页没有正文容器（观察器挂不上，也不会去读任何东西）', () => {
    document.body.innerHTML = `
      <div id="Main">
        <div class="box box-title node-header"><div class="cell page-content-header">酷工作</div></div>
        <div class="cell item"><a href="/t/1245478">某岗位</a></div>
      </div>
    `
    expect(v2exSite.jdProbeElement()).toBeNull()
    expect(v2exSite.jdContainerElement()).toBeNull()
    expect(v2exSite.readJd()).toBeNull()
  })

  it('观察器盯的是正文所在的那个 cell（正文整块被替换也能察觉）', () => {
    mountTopic({ nodePath: '/go/jobs', nodeName: '酷工作', title: '招人', body: '正文' })

    const container = v2exSite.jdContainerElement()
    expect(container?.classList.contains('cell')).toBe(true)
    expect(container?.querySelector('.topic_content')).not.toBeNull()
  })
})
