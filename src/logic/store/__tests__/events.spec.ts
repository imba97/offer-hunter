import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyStoreChange, onStoreChange } from '~/logic/store/events'

/**
 * 存储变更广播（替代 `storage.onChanged`）。
 *
 * 这一层的失败模式是「静默的」：通知发错了通道、订阅方被别人的 scope 触发、
 * 后台没响应时把异常抛回写入方 —— 三种都不会让测试之外的任何东西报错，
 * 只会让界面显示旧值。所以三件事都单独钉住：
 *  1. 写入方发出的载荷形状与通道名（后台按它注册处理器）；
 *  2. **通知失败不影响写入**（fire-and-forget 的全部意义）；
 *  3. 订阅方只认自己的 scope，且丢弃不合法载荷。
 */

const mocks = vi.hoisted(() => ({
  callBackground: vi.fn<(id: string, data?: unknown) => Promise<unknown>>(),
  broadcastToPages: vi.fn<(id: string, data?: unknown) => void>(),
  onPageBroadcast: vi.fn<(id: string, callback: (data: unknown) => void) => () => void>(),
}))

vi.mock('~/logic/messaging', () => ({
  callBackground: mocks.callBackground,
  broadcastToPages: mocks.broadcastToPages,
  onPageBroadcast: mocks.onPageBroadcast,
}))

/** 取出 onStoreChange 交给 onPageBroadcast 的那个回调，用来扮演「别处发来的广播」 */
function pageListener(): (data: unknown) => void {
  const call = mocks.onPageBroadcast.mock.calls.at(-1)
  if (!call)
    throw new Error('onPageBroadcast 没有被调用')
  return call[1]
}

beforeEach(() => {
  mocks.callBackground.mockReset()
  mocks.broadcastToPages.mockReset()
  mocks.onPageBroadcast.mockReset()
  mocks.callBackground.mockResolvedValue(undefined)
  mocks.onPageBroadcast.mockReturnValue(() => {})
})

describe('写入方通知', () => {
  it('直接广播：broadcastToPages("store-changed", { scope, kind })', () => {
    notifyStoreChange('ai', 'update')

    expect(mocks.broadcastToPages).toHaveBeenCalledTimes(1)
    expect(mocks.broadcastToPages).toHaveBeenCalledWith('store-changed', { scope: 'ai', kind: 'update' })
  })

  it('kind 缺省是 update；cleared 也能发出去', () => {
    notifyStoreChange('records')
    notifyStoreChange('resume', 'cleared')

    expect(mocks.broadcastToPages).toHaveBeenNthCalledWith(1, 'store-changed', { scope: 'records', kind: 'update' })
    expect(mocks.broadcastToPages).toHaveBeenNthCalledWith(2, 'store-changed', { scope: 'resume', kind: 'cleared' })
  })

  /*
   * 这条曾经是错的：通知走的是 `callBackground`（页面 → 后台 → 转发），
   * 而 `runtime.sendMessage` 不投递给发送者自身 —— 后台自己写账本时没人应答，
   * 每次写都在真机控制台留一条「通知 records 变更失败（写入已落库，不影响功能）」。
   * 现在写入方直接广播，因此**这条通道不该再经过后台的请求处理器**。
   */
  it('不经过后台请求通道（否则后台自己写的时候没人应答）', () => {
    notifyStoreChange('records')

    expect(mocks.callBackground).not.toHaveBeenCalled()
  })

  it('广播失败时只记日志：不抛、也不影响已经落库的写入', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.broadcastToPages.mockImplementation(() => {
      throw new Error('没有接收方')
    })

    expect(() => notifyStoreChange('prompts')).not.toThrow()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('offer-hunter')
  })
})

describe('订阅方', () => {
  it('订阅的是同一条通道', () => {
    onStoreChange('ai', () => {})

    expect(mocks.onPageBroadcast).toHaveBeenCalledTimes(1)
    expect(mocks.onPageBroadcast.mock.calls[0]?.[0]).toBe('store-changed')
  })

  it('只在自己 scope 的广播上回调，并带上 kind', () => {
    const received: string[] = []
    onStoreChange('resume', kind => received.push(kind))

    const listener = pageListener()
    listener({ scope: 'ai', kind: 'update' })
    listener({ scope: 'resume', kind: 'update' })
    listener({ scope: 'records', kind: 'cleared' })
    listener({ scope: 'resume', kind: 'cleared' })

    expect(received).toEqual(['update', 'cleared'])
  })

  it('忽略不合法载荷（缺 scope / 认不出的 kind / 根本不是对象）', () => {
    const received: string[] = []
    onStoreChange('ai', kind => received.push(kind))

    const listener = pageListener()
    for (const bad of [undefined, null, 'ai', 42, [], {}, { scope: 'ai' }, { kind: 'update' }, { scope: 'ai', kind: 'nope' }])
      listener(bad)

    expect(received).toEqual([])
  })

  it('返回的取消订阅函数要同时摘掉本地与远程两路', () => {
    const off = vi.fn()
    mocks.onPageBroadcast.mockReturnValue(off)

    const received: string[] = []
    const unsubscribe = onStoreChange('prompts', kind => received.push(kind))
    unsubscribe()

    expect(off).toHaveBeenCalledTimes(1)
    // 远程那路由 onPageBroadcast 负责；本地那路必须自己摘掉，否则会累积僵尸订阅
    notifyStoreChange('prompts')
    expect(received).toEqual([])
  })
})

describe('发起方自己也要收到（本地派发）', () => {
  /*
   * `runtime.sendMessage` 不投递给发送者帧 —— 所以「谁改的谁自己知道」这件事
   * 不能指望广播。这条曾经漏掉：清空数据由设置页发起，它自己收不到那 4 条
   * `cleared`，三个 ref（含 API Key）继续显示旧值，而界面文案写着「各页面会立即
   * 恢复默认值」；用户再改一个字就把已清数据写回库里。
   */
  it('notifyStoreChange 会在本上下文派发一次', () => {
    const received: string[] = []
    onStoreChange('ai', kind => received.push(kind))

    notifyStoreChange('ai', 'cleared')

    expect(received).toEqual(['cleared'])
  })

  it('本地派发同样按 scope 过滤', () => {
    const received: string[] = []
    onStoreChange('resume', kind => received.push(kind))

    notifyStoreChange('ai', 'cleared')
    notifyStoreChange('resume', 'update')

    expect(received).toEqual(['update'])
  })

  it('一个订阅方抛错不影响其他订阅方，也不影响写入方', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const received: string[] = []
    onStoreChange('records', () => {
      throw new Error('这个订阅方坏了')
    })
    onStoreChange('records', kind => received.push(kind))

    expect(() => notifyStoreChange('records')).not.toThrow()
    expect(received).toEqual(['update'])
    expect(warn).toHaveBeenCalled()
  })
})
