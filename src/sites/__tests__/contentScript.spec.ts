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

/** 读回「当前岗位」：走内容脚本自己注册的那条消息 */
async function currentJob() {
  const handler = captured.handlers.get('request-current-job')
  if (!handler)
    throw new Error('内容脚本没有注册 request-current-job')
  const res = await handler({ data: {} }) as { job: unknown }
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
