import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 后台转发（relay）的行为测试。
 *
 * 钉的是一件真机故障：**内容脚本失联时面板永久转圈**。扩展重载 / 更新、页面正在
 * 跳转、标签被 discard 之后，消息不会有任何回复（webext-bridge 会把未投递的消息
 * 留在队列里等重连，而扩展重载后它自己都恢复不了），此前的实现只有 try/catch、
 * 没有时间上限，于是 promise 永不 settle。
 *
 * 这里用假的 webext-bridge：捕获后台注册的消息处理器，并让 `sendMessage` 永不回复。
 */

const handlers = new Map<string, (payload: any) => unknown>()

vi.mock('webext-bridge/background', () => ({
  onMessage: vi.fn(),
  sendMessage: vi.fn(() => new Promise(() => {})),
}))

vi.mock('~/logic/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/logic/messaging')>()
  return {
    ...actual,
    handleBackgroundRequests: (table: Record<string, (payload: any) => unknown>) => {
      for (const [id, handler] of Object.entries(table))
        handlers.set(id, handler)
    },
    broadcastToPages: vi.fn(),
  }
})

// 存储层在 SW 里会碰 chrome.storage，这里不关心它
vi.mock('~/logic/store/ready', () => ({ ensureStoreReady: vi.fn(async () => {}) }))
vi.mock('~/logic/storage', () => ({
  readAiSettings: vi.fn(async () => ({})),
  readPromptSettings: vi.fn(async () => ({})),
  readRecords: vi.fn(async () => ({})),
  readResume: vi.fn(async () => ({ markdown: '' })),
  upsertRecord: vi.fn(async () => {}),
}))

/*
 * ⚠ `webextension-polyfill` 一加载就抛「This script should only be loaded in a
 *   browser extension」，而存储层会 import 它 —— 必须换成假的（与 logic 那几组
 *   测试同款做法，见 messaging.spec.ts）。
 *
 * 这里只需覆盖**后台顶层代码碰到的那些 API**（runtime / action / tabs 的事件注册），
 * 本组测试关心的是转发链路，不是浏览器 API 的行为。
 */
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      getURL: vi.fn(() => ''),
    },
    action: { onClicked: { addListener: vi.fn() } },
    tabs: {
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
    },
    sidePanel: { open: vi.fn(async () => {}) },
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    // 开发期的内容脚本 HMR 会碰它（见 background/contentScriptHMR.ts）
    webNavigation: { onCommitted: { addListener: vi.fn() } },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
  },
}))

/**
 * 后台模块的顶层代码会注册消息表 —— **整个文件只导入一次**（动态 import 会缓存），
 * 之后每个用例都复用同一份注册表（清空它会让后续用例找不到处理器）。
 */
const backgroundReady = import('../main')

/**
 * 侧边栏发来的那条消息：`handleBackgroundRequests` 收的是**已拆包的 data**，
 * 所以这里直接把 `{ tabId }` 递进去（拆包发生在 logic/messaging.ts 里）。
 */
function relay(payload: unknown) {
  const handler = handlers.get('relay-current-job')
  if (!handler)
    throw new Error('后台没有注册 relay-current-job')
  return handler(payload) as Promise<{ ok: boolean, reason?: string }>
}

beforeEach(async () => {
  await backgroundReady
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('转发到内容脚本', () => {
  it('没有目标标签页时直接给出理由，不挂起', async () => {
    const res = await relay({})

    expect(res.ok).toBe(false)
    expect(res.reason).toContain('面板没有给出目标标签页')
  })

  it('内容脚本失联时超时报错，而不是永久转圈', async () => {
    const pending = relay({ tabId: 7 })

    // 先让它挂一会儿：没超时之前不该 settle
    await vi.advanceTimersByTimeAsync(1_000)
    let settled: string | null = null
    void pending.then(
      (v) => { settled = `resolved: ${JSON.stringify(v)}` },
      (e) => { settled = `rejected: ${String(e)}` },
    )
    await Promise.resolve()
    expect(settled).toBe(null)

    // 越过超时上限 → 必须给出可照做的失败
    await vi.advanceTimersByTimeAsync(10_000)
    const res = await pending

    expect(res.ok).toBe(false)
    expect(res.reason).toContain('页面通信失败')
    expect(res.reason).toContain('刷新页面')
  })
})
