import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bossSite } from '~/sites/boss'
import { createContentScript } from '~/sites/content-script'

/**
 * 内容脚本的行为测试（以 BOSS 适配器驱动）。
 *
 * 这一支的核心是「JD 一变就读」——它靠 MutationObserver，而不是定时器。
 * 所以测试的关键手法是：**只推进去抖窗口（120ms），不推进兜底轮询（5s）**。
 * 如果观察器没生效，这 120ms 内不会有任何更新，测试立刻红。
 *
 * 内容脚本的 webext-bridge 依赖浏览器运行时，这里换成假的（vi.mock 会被提升到
 * import 之前，所以上面的静态 import 拿到的是 mock 版本）。岗位状态是私有的，
 * 通过它自己注册的 'request-current-job' 处理器读回来 —— 那正是侧边栏走的路，
 * 因此也就顺带覆盖了那条真实链路。
 */

/** 捕获内容脚本注册的消息处理器，模拟 webext-bridge 的投递 */
const captured = vi.hoisted(() => ({
  handlers: new Map<string, (msg: { data?: unknown }) => unknown>(),
  sent: [] as Array<{ type: string, data: unknown }>,
}))

vi.mock('webext-bridge/content-script', () => ({
  onMessage: vi.fn((type: string, handler: (msg: { data?: unknown }) => unknown) => {
    captured.handlers.set(type, handler)
  }),
  sendMessage: vi.fn((type: string, data: unknown) => {
    captured.sent.push({ type, data })
    return Promise.resolve()
  }),
}))

function mountDetail(jd: string, title = '高级后端工程师', company = '某某科技'): void {
  document.body.innerHTML = `
    <div class="job-detail-box">
      <h1 class="job-name">${title}</h1>
      <span class="company-name">${company}</span>
      <div class="job-detail-body"><div class="desc"><p>${jd}</p></div></div>
    </div>
  `
}

/** 在**同一个容器内**改 JD —— 真实 SPA 切换岗位就是这样更新的 */
function setJd(jd: string): void {
  const desc = document.querySelector('.desc')
  if (!desc)
    throw new Error('详情容器不存在')
  desc.innerHTML = `<p>${jd}</p>`
}

/** 读回「当前岗位」：走内容脚本自己注册的那条消息（`force` = 面板上的手动刷新） */
async function currentJob(force = false) {
  const handler = captured.handlers.get('request-current-job')
  if (!handler)
    throw new Error('内容脚本没有注册 request-current-job')
  const res = await handler({ data: { force } }) as { job: unknown }
  return res.job as Record<string, any> | null
}

/**
 * 模拟注入脚本报来一次详情接口响应。
 *
 * jsdom 构造的 MessageEvent 里 source 为 null，而内容脚本要求 source === window
 * （防止别的窗口/框架伪造消息），因此这里显式把它指成 window。
 */
function pushApiResponse(securityId: string, jobName: string, jd: string): void {
  const ev = new MessageEvent('message', {
    data: {
      channel: '__offer_hunter__',
      type: 'api',
      url: `https://www.zhipin.com/wapi/zpgeek/job/detail.json?securityId=${securityId}`,
      ok: true,
      keys: ['jobInfo'],
      data: { zpData: { jobInfo: { jobName, postDescription: jd } } },
    },
  })
  Object.defineProperty(ev, 'source', { value: window })
  window.dispatchEvent(ev)
}

/** 最近一次推给后台的岗位 */
function lastPushedJob(): Record<string, any> | null {
  const pushes = captured.sent.filter(m => m.type === 'job-changed')
  const last = pushes[pushes.length - 1]
  return (last?.data as { job?: Record<string, any> } | undefined)?.job ?? null
}

let dispose: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  captured.handlers.clear()
  captured.sent.length = 0
  // jsdom 的 visibilityState 不保证是 visible，显式放开，避免 check 被后台跳过
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})

afterEach(() => {
  dispose?.()
  dispose = null
  vi.useRealTimers()
  // 有的用例会给 window.location 打桩（模拟地址栏上的 securityId），用完必须还原
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('内容脚本的 JD 观察', () => {
  it('挂载后立刻读一次当前 JD', async () => {
    mountDetail('岗位职责：写代码')

    dispose = createContentScript(bossSite)

    const job = await currentJob()
    expect(job?.jdText).toBe('岗位职责：写代码')
    expect(job?.source).toBe('dom')
  })

  it('jd 一变就读，不需要等兜底轮询', async () => {
    mountDetail('旧 JD')
    dispose = createContentScript(bossSite)
    expect((await currentJob())?.jdText).toBe('旧 JD')

    setJd('新 JD：负责服务端架构设计')

    // 只推进去抖窗口；观察器若失效，这里什么都不会发生
    await vi.advanceTimersByTimeAsync(150)

    expect((await currentJob())?.jdText).toBe('新 JD：负责服务端架构设计')
    // 推给后台，由后台广播到各扩展页面（侧边栏可能不止一个）
    expect(captured.sent.some(m => m.type === 'job-changed')).toBe(true)
  })

  it('dom 里读到的岗位名/公司名会带进兜底岗位', async () => {
    mountDetail('岗位职责：写代码', '资深前端工程师', '某互联网公司')

    dispose = createContentScript(bossSite)

    const job = await currentJob()
    expect(job?.job.title).toBe('资深前端工程师')
    expect(job?.job.company).toBe('某互联网公司')
  })

  it('同一岗位的折叠版 JD 不会覆盖已更完整的内容', async () => {
    mountDetail('完整的 JD 正文，包含职责与要求两部分')
    dispose = createContentScript(bossSite)
    expect((await currentJob())?.jdText).toContain('完整的 JD 正文')

    // 同一岗位（URL 上没有 securityId 时按文本包含判断）被折叠成更短的版本
    setJd('完整的 JD 正文')
    await vi.advanceTimersByTimeAsync(150)

    expect((await currentJob())?.jdText).toBe('完整的 JD 正文，包含职责与要求两部分')
  })

  it('有接口数据时，认不出同一岗位就保留接口数据', async () => {
    mountDetail('岗位 A 的 JD')
    dispose = createContentScript(bossSite)

    // 模拟接口已捕获到岗位 B（与 DOM 文本互不包含）。
    // jsdom 构造的 MessageEvent 里 source 为 null，而内容脚本要求 source === window
    // （防止别的窗口/框架伪造消息），因此这里显式把它指成 window。
    const injected = new MessageEvent('message', {
      data: {
        channel: '__offer_hunter__',
        type: 'api',
        url: 'https://www.zhipin.com/wapi/zpgeek/job/detail.json?securityId=sid-b',
        ok: true,
        keys: ['jobInfo'],
        data: {
          zpData: {
            jobInfo: { jobName: '接口岗位 B', postDescription: '岗位 B 的完整 JD' },
          },
        },
      },
    })
    Object.defineProperty(injected, 'source', { value: window })
    window.dispatchEvent(injected)

    await vi.advanceTimersByTimeAsync(150)

    expect((await currentJob())?.job.title).toBe('接口岗位 B')
    expect((await currentJob())?.jdText).toBe('岗位 B 的完整 JD')
  })

  it('容器被 SPA 换掉后，兜底轮询能把观察器重新挂上', async () => {
    mountDetail('第一个岗位的 JD')
    dispose = createContentScript(bossSite)

    // 整块容器被替换：旧观察器跟着旧节点一起失效
    mountDetail('换掉的容器里的 JD')
    await vi.advanceTimersByTimeAsync(5000)

    expect((await currentJob())?.jdText).toBe('换掉的容器里的 JD')
  })

  it('拆卸后不再观察 DOM（监听器与定时器都摘掉了）', async () => {
    mountDetail('JD')
    const teardown = createContentScript(bossSite)
    // 先读一次，确认自己是活的
    expect((await currentJob())?.jdText).toBe('JD')

    teardown()
    captured.sent.length = 0

    setJd('拆卸之后的新 JD')
    // 推进超过兜底轮询间隔：若定时器没被清掉，这里就会再推一次岗位变化
    await vi.advanceTimersByTimeAsync(5000)

    expect(captured.sent.length).toBe(0)
  })
})

/**
 * 强制刷新（面板上的「刷新当前岗位」）。
 *
 * 真机故障：BOSS 新版职位页的地址里没有 securityId，而刷新时如果只认地址上的
 * 标识，「同一个岗位」会被当成认不出来的岗位重建 —— 接口给的薪资/公司没了，
 * 岗位标识也没了，于是面板查不到这份岗位的分析结果（结果只留在提示条里）。
 *
 * 这里的 window.location 是 jsdom 的 about:blank，正好等价于「地址里没有标识」。
 */
/**
 * 站点给不出标识时的岗位身份。
 *
 * BOSS 新版职位页的地址里没有 securityId，而详情可能是服务端渲染（页面里没有
 * 可捕获的接口响应）—— 这种岗位只能靠内容脚本在第一次读到它时**定下**一个本地
 * 身份。否则页面上正文一增量渲染就换了个身份，用户刚分析过的结果会凭空消失
 * （面板按新身份查不到旧记录，症状是「点了分析，分数只出现在提示条里」）。
 */
describe('没有站点标识时的岗位身份', () => {
  it('第一次读到就定下身份，正文变长后仍是同一个身份', async () => {
    mountDetail('岗位职责：写代码')
    dispose = createContentScript(bossSite)

    const first = await currentJob()
    expect(first?.site.naturalKey).toMatch(/^~[0-9a-f]{16}$/)

    // 页面上正文继续渲染（更完整的版本，包含原来那段）
    setJd('岗位职责：写代码，任职要求：三年以上经验，熟悉分布式系统')
    await vi.advanceTimersByTimeAsync(150)

    const next = await currentJob()
    expect(next?.jdText).toContain('任职要求')
    // 身份必须没变 —— 否则账本里那份分析结果就查不回来了
    expect(next?.site.naturalKey).toBe(first?.site.naturalKey)
  })

  it('换成另一个岗位才重新定身份', async () => {
    mountDetail('岗位 A 的 JD')
    dispose = createContentScript(bossSite)
    const first = await currentJob()

    // 内容完全不同（互不包含）→ 适配器认不出是同一个岗位
    setJd('岗位 B 的 JD，内容与 A 完全不同')
    await vi.advanceTimersByTimeAsync(150)

    const next = await currentJob()
    expect(next?.site.naturalKey).toMatch(/^~[0-9a-f]{16}$/)
    expect(next?.site.naturalKey).not.toBe(first?.site.naturalKey)
  })
})

describe('强制刷新', () => {
  it('地址里没有标识时，不丢已有岗位的标识与接口数据', async () => {
    // 页面正文比接口多几行（BOSS 的 DOM 常常如此），但接口那段包含在内 ——
    // 适配器据此认定这是同一个岗位
    mountDetail('岗位职责：写代码，任职要求：三年经验')
    dispose = createContentScript(bossSite)

    pushApiResponse('sid-1', '资深后端工程师', '岗位职责：写代码')
    await vi.advanceTimersByTimeAsync(150)
    expect((await currentJob())?.site.naturalKey).toBe('sid-1')

    // 用户在面板上点「刷新当前岗位」
    const refreshed = await currentJob(true)

    // 标识沿用下来了 —— 否则账本里那份分析结果就再也查不回来
    expect(refreshed?.site.naturalKey).toBe('sid-1')
    // 接口给的岗位名还在（DOM 里的标题是另一个，不该反向覆盖接口数据）
    expect(refreshed?.job.title).toBe('资深后端工程师')
    // 正文换成页面上更完整的那份
    expect(refreshed?.jdText).toContain('任职要求：三年经验')
  })

  it('地址里没有标识、又认不出是同一岗位时，不把接口数据降级成 DOM 数据', async () => {
    mountDetail('页面上的 JD，与接口那份排版完全不同')
    dispose = createContentScript(bossSite)

    pushApiResponse('sid-1', '资深后端工程师', '接口里的 JD 文案')
    await vi.advanceTimersByTimeAsync(150)

    const refreshed = await currentJob(true)

    // 两条兜底路径必须给出同一个答案：观察器在同样情形下也是「保留接口数据」。
    // 降级的代价是把薪资/公司抹掉、并换掉身份，让已分析的结果变成孤儿。
    expect(refreshed?.source).toBe('api')
    expect(refreshed?.site.naturalKey).toBe('sid-1')
    expect(refreshed?.job.title).toBe('资深后端工程师')
    expect(refreshed?.jdText).toBe('接口里的 JD 文案')
  })

  it('地址上写着另一个岗位标识时，按新标识重建（这是能证伪的情形）', async () => {
    mountDetail('岗位 B 的 JD')
    dispose = createContentScript(bossSite)

    pushApiResponse('sid-a', '岗位 A', '岗位 A 的 JD')
    await vi.advanceTimersByTimeAsync(150)
    expect((await currentJob())?.site.naturalKey).toBe('sid-a')

    // 地址栏换成了另一个 securityId → 不是「认不出」，而是明确是另一个岗位
    vi.stubGlobal('location', {
      href: 'https://www.zhipin.com/job_detail/?securityId=sid-b',
      origin: 'https://www.zhipin.com',
    })

    const refreshed = await currentJob(true)

    expect(refreshed?.site.naturalKey).toBe('sid-b')
    expect(refreshed?.source).toBe('dom')
    expect(refreshed?.job.title).not.toBe('岗位 A')
  })
})

/**
 * 切换列表里的岗位（这是用户点岗位卡片时真实发生的事）。
 *
 * 关键不变量：**新岗位必须推给后台**。侧边栏是靠这条推送更新的，
 * 不推就等于面板停在旧岗位上 —— 用户看到的现象正是「切换岗位没反应」。
 */
describe('切换岗位', () => {
  it('接口捕获到另一个岗位时，把新岗位推给后台', async () => {
    mountDetail('岗位 A 的 JD')
    dispose = createContentScript(bossSite)
    captured.sent.length = 0

    pushApiResponse('sid-b', '岗位 B', '岗位 B 的 JD')
    await vi.advanceTimersByTimeAsync(150)

    expect((await currentJob())?.site.naturalKey).toBe('sid-b')
    expect((await currentJob())?.job.title).toBe('岗位 B')
    // 推送必须真的发生，且带的是新岗位
    expect(lastPushedJob()?.job.title).toBe('岗位 B')
  })

  it('页面文本换成另一个岗位时，把新岗位推给后台', async () => {
    mountDetail('岗位 A 的 JD', '岗位 A', '公司 A')
    dispose = createContentScript(bossSite)
    captured.sent.length = 0

    // SPA 在同一个容器里换成另一个岗位的描述与标题
    setJd('岗位 B 的 JD，内容与 A 完全不同')
    const title = document.querySelector('.job-name')
    if (title)
      title.textContent = '岗位 B'

    await vi.advanceTimersByTimeAsync(150)

    expect((await currentJob())?.jdText).toContain('岗位 B 的 JD')
    expect(lastPushedJob()?.jdText).toContain('岗位 B 的 JD')
  })

  it('同一岗位的折叠版不会误推成「新岗位」', async () => {
    mountDetail('完整的 JD 正文，包含职责与要求两部分')
    dispose = createContentScript(bossSite)
    captured.sent.length = 0

    setJd('完整的 JD 正文')
    await vi.advanceTimersByTimeAsync(150)

    // 内容没变长（是被折叠），不该有任何推送
    expect(captured.sent.filter(m => m.type === 'job-changed')).toHaveLength(0)
  })
})
