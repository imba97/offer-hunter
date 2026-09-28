import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import browser from 'webextension-polyfill'
import { currentJob, listenForTabChanges, pageState, refreshCurrentJob, refreshPageState } from '../state'

/**
 * 标签变化监听的测试。
 *
 * 这一支解决两个真实延迟：从别的页面新开 BOSS 职位页后面板还认为「不在 BOSS」、
 * 从 BOSS 切走后旧岗位信息赖着不走。测试用假的 browser API 驱动监听器，
 * 断言「该触发的触发、不该触发的别触发（别的标签/别的窗口的加载与我们无关）」。
 *
 * vi.mock 会被提升到 import 之前，所以上面的静态 import 拿到的是假实现。
 */
vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: {
      query: vi.fn(),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: { getCurrent: vi.fn(() => Promise.resolve({ id: 1 })) },
    runtime: {
      sendMessage: vi.fn(() => Promise.resolve({ ok: true, job: null })),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}))

interface ActivatedInfo {
  tabId: number
  windowId: number
}

interface UpdatedInfo {
  url?: string
  status?: string
}

const tabs = browser.tabs as any
let activated: ((info: ActivatedInfo) => void) | null = null
let updated: ((tabId: number, info: UpdatedInfo) => void) | null = null

/** 本窗口的活动标签 */
let activeTab: { id: number, url: string } = { id: 100, url: '' }
/** 全局（含其它窗口）里能匹配到站点模式的标签页 */
let siteTabs: Array<{ id: number, url: string }> = []

/**
 * 让 tabs.query 像真的一样按参数回答：
 *  - `{active:true, currentWindow:true}` → 本窗口活动标签
 *  - `{url: pattern}` → 全局匹配该模式的标签页
 *
 * 这一点很要紧：refreshPageState 会先看活动标签，**再全局回退**去找站点标签页。
 * 一个只会返回固定值的假实现根本测不出这两条路径的差别。
 */
function installTabQuery(): void {
  tabs.query.mockImplementation((info?: { url?: string }) => {
    if (info && typeof info.url === 'string') {
      const pattern = info.url
      return Promise.resolve(siteTabs.filter(t => matchPattern(t.url, pattern)))
    }
    return Promise.resolve(activeTab.url ? [activeTab] : [{ id: activeTab.id }])
  })
}

/** 极简 match pattern：只支持 `*://*.host/*` 与我们用到的形态 */
function matchPattern(url: string, pattern: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    const m = pattern.match(/^\*:\/\/\*?\.?([^/]+)\/\*$/)
    if (!m)
      return false
    const domain = m[1].toLowerCase()
    return host === domain || host.endsWith(`.${domain}`)
  }
  catch {
    return false
  }
}

function setActiveTab(url: string, id = 100): void {
  activeTab = { id, url }
}

/** 另一个窗口里的站点标签页（用户把侧边栏停在一边、在别处操作） */
function setSiteTabsElsewhere(tabs_: Array<{ id: number, url: string }>): void {
  siteTabs = tabs_
}

beforeEach(() => {
  vi.useFakeTimers()
  tabs.query.mockReset()
  activeTab = { id: 100, url: '' }
  siteTabs = []
  installTabQuery()
  tabs.onActivated.addListener.mockImplementation((cb: (info: ActivatedInfo) => void) => {
    activated = cb
  })
  tabs.onUpdated.addListener.mockImplementation((cb: (tabId: number, info: UpdatedInfo) => void) => {
    updated = cb
  })
  tabs.onActivated.removeListener.mockClear()
  tabs.onUpdated.removeListener.mockClear()
  activated = null
  updated = null
  // pageState 是模块级单例，用例之间要复位，否则前一个用例查过的痕迹会漏过来
  pageState.onSupportedSite = false
  pageState.checked = false
})

afterEach(() => {
  vi.useRealTimers()
})

describe('刷新页面状态（refreshPageState）', () => {
  it('活动标签就是受支持站点时标记为在站点上', async () => {
    setActiveTab('https://www.zhipin.com/web/geek/jobs')
    await refreshPageState()
    expect(pageState.onSupportedSite).toBe(true)
  })

  it('活动标签不是站点、别的窗口有站点标签页时，**不算**在站点上', async () => {
    /*
     * 这一条是本轮修复的核心：
     * 面板表达的是「你现在看的这个标签页上的岗位」。曾经后台会**全局**回退去找
     * 任意一个站点标签页，于是从 BOSS 切到别的页面后面板仍然显示着那个岗位 ——
     * 岗位是从另一个残留的标签页取回来的。判据必须是本窗口的活动标签。
     */
    setActiveTab('https://example.com')
    setSiteTabsElsewhere([{ id: 42, url: 'https://www.zhipin.com/web/geek/jobs' }])

    await refreshPageState()

    expect(pageState.onSupportedSite).toBe(false)
  })

  it('全局都没有站点标签页时标记为不在站点上', async () => {
    setActiveTab('https://example.com')
    setSiteTabsElsewhere([])

    await refreshPageState()

    expect(pageState.onSupportedSite).toBe(false)
  })

  it('查过之后 checked 才为真（面板据此避免闪出未验证的提示语）', async () => {
    // 刚打开面板时查询还没回来：不能直接按「不在站点上」渲染
    expect(pageState.checked).toBe(false)

    setActiveTab('https://www.zhipin.com/web/geek/jobs')
    await refreshPageState()

    expect(pageState.checked).toBe(true)
  })

  it('连标签页都查不动时也算查过，界面不会永远停在加载态', async () => {
    tabs.query.mockRejectedValue(new Error('boom'))

    await refreshPageState()

    expect(pageState.checked).toBe(true)
    expect(pageState.onSupportedSite).toBe(false)
  })
})

/**
 * 取岗位时的清空规则。
 *
 * 这三条对应三个真实场景：离开站点、页面上没选岗位、通信暂时失败。
 * 以前只在 `res.ok` 时赋值，导致第一种场景下旧岗位永远赖在面板上。
 */
describe('取岗位时的清空规则', () => {
  const relay = browser.runtime.sendMessage as any

  it('当前标签页不是站点时清空岗位，且不去够别的标签页', async () => {
    currentJob.value = { jdText: '上一个岗位' } as never
    setActiveTab('https://example.com')
    // 别的窗口还留着一个站点标签页 —— 但它与「你现在看的这个页面」无关
    setSiteTabsElsewhere([{ id: 42, url: 'https://www.zhipin.com/web/geek/jobs' }])
    relay.mockClear()

    await refreshCurrentJob()

    expect(currentJob.value).toBeNull()
    // 没有任何目标标签页，就不该白跑一趟后台
    expect(relay).not.toHaveBeenCalled()
  })

  it('是站点时把该标签页的 id 一起交给后台', async () => {
    setActiveTab('https://www.zhipin.com/web/geek/jobs', 777)
    relay.mockResolvedValue({ ok: true, job: null })

    await refreshCurrentJob()

    expect(relay).toHaveBeenCalledWith(expect.objectContaining({
      id: 'relay-current-job',
      data: { force: false, tabId: 777 },
    }))
  })

  it('后台返回成功、但岗位为空时清空（页面上确实没选岗位）', async () => {
    currentJob.value = { jdText: '上一个岗位' } as never
    setActiveTab('https://www.zhipin.com/web/geek/jobs')
    relay.mockResolvedValue({ ok: true, job: null })

    await refreshCurrentJob()

    expect(currentJob.value).toBeNull()
  })

  it('有目标标签页但通信失败时保留旧岗位（别把面板闪成空的）', async () => {
    currentJob.value = { jdText: '上一个岗位' } as never
    setActiveTab('https://www.zhipin.com/web/geek/jobs')
    relay.mockResolvedValue({ ok: false, reason: '页面通信失败' })

    await refreshCurrentJob()

    // currentJob 是 reactive 包装，比内容而不是对象标识
    expect(currentJob.value).toMatchObject({ jdText: '上一个岗位' })
  })
})

describe('listenForTabChanges', () => {
  it('切换标签后（去抖）触发一次回调', async () => {
    const onChange = vi.fn()
    const stop = listenForTabChanges(onChange)
    await vi.advanceTimersByTimeAsync(0)

    activated?.({ tabId: 7, windowId: 1 })
    await vi.advanceTimersByTimeAsync(300)

    expect(onChange).toHaveBeenCalledTimes(1)
    stop()
  })

  it('连续事件被合并成一次回调', async () => {
    const onChange = vi.fn()
    const stop = listenForTabChanges(onChange)
    await vi.advanceTimersByTimeAsync(0)

    activated?.({ tabId: 7, windowId: 1 })
    updated?.(7, { status: 'loading' })
    updated?.(7, { url: 'https://www.zhipin.com/web/geek/jobs' })
    updated?.(7, { status: 'complete' })
    await vi.advanceTimersByTimeAsync(300)

    expect(onChange).toHaveBeenCalledTimes(1)
    stop()
  })

  it('其它窗口的标签切换不影响本面板', async () => {
    /*
     * 目标标签页的判据是**本窗口**的活动标签，所以别处的标签切换与本面板无关。
     * 不过滤的话，用户在别处每切一次标签都会让本面板白跑一趟
     * 「查标签页 + 转发内容脚本」。
     */
    const onChange = vi.fn()
    const stop = listenForTabChanges(onChange)
    await vi.advanceTimersByTimeAsync(0)

    activated?.({ tabId: 7, windowId: 999 })
    await vi.advanceTimersByTimeAsync(300)

    expect(onChange).not.toHaveBeenCalled()
    stop()
  })

  it('非活动标签的加载不触发回调', async () => {
    const onChange = vi.fn()
    const stop = listenForTabChanges(onChange)
    await vi.advanceTimersByTimeAsync(0)

    activated?.({ tabId: 7, windowId: 1 })
    await vi.advanceTimersByTimeAsync(300)
    expect(onChange).toHaveBeenCalledTimes(1)

    // 其它标签在后台加载：与我们无关
    updated?.(8, { url: 'https://www.zhipin.com/web/geek/jobs' })
    await vi.advanceTimersByTimeAsync(300)
    expect(onChange).toHaveBeenCalledTimes(1)

    // 活动标签自身加载完成：要跟上
    updated?.(7, { status: 'complete' })
    await vi.advanceTimersByTimeAsync(300)
    expect(onChange).toHaveBeenCalledTimes(2)

    stop()
  })

  it('注销后不再触发，也不会留下待执行的去抖任务', async () => {
    const onChange = vi.fn()
    const stop = listenForTabChanges(onChange)
    await vi.advanceTimersByTimeAsync(0)

    activated?.({ tabId: 7, windowId: 1 })
    stop()
    await vi.advanceTimersByTimeAsync(300)

    expect(onChange).not.toHaveBeenCalled()
    expect(tabs.onActivated.removeListener).toHaveBeenCalled()
    expect(tabs.onUpdated.removeListener).toHaveBeenCalled()
  })
})
