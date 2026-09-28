import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import browser from 'webextension-polyfill'
import { listenForTabChanges, pageState, refreshPageState } from '../state'

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

function setActiveTab(url: string, id = 100): void {
  tabs.query.mockResolvedValue([{ id, url }])
}

beforeEach(() => {
  vi.useFakeTimers()
  tabs.query.mockReset()
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
  pageState.onBoss = false
})

afterEach(() => {
  vi.useRealTimers()
})

describe('refreshPageState', () => {
  it('boss 页面标记为在 BOSS', async () => {
    setActiveTab('https://www.zhipin.com/web/geek/jobs')
    await refreshPageState()
    expect(pageState.onBoss).toBe(true)
  })

  it('非 boss 页面标记为不在 BOSS', async () => {
    setActiveTab('https://example.com')
    await refreshPageState()
    expect(pageState.onBoss).toBe(false)
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

  it('别的窗口的标签切换不影响本面板', async () => {
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
