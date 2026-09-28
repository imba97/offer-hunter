import { beforeEach, describe, expect, it, vi } from 'vitest'
import browser from 'webextension-polyfill'
import { broadcastToPages, callBackground, handleBackgroundRequests, onPageBroadcast } from '../messaging'

/**
 * 扩展页面 ↔ 后台 消息通道的测试。
 *
 * 这一支是「点分析时后台报 Cannot read properties of undefined (reading 'fingerprint')」
 * 那类故障的回归测试：原生 runtime.sendMessage 里**没有**共享槽位，
 * 两个页面可以同时各问各的，一个页面关闭也不会影响另一个。
 *
 * 假实现按 polyfill 的语义模拟投递：把消息交给所有监听器，
 * 第一个「有返回值」的监听器决定响应（返回 undefined 视为没接手）。
 */
const fake = vi.hoisted(() => ({
  listeners: new Set<(message: unknown) => unknown>(),
}))

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      sendMessage: vi.fn(async (message: unknown) => {
        for (const listener of fake.listeners) {
          const result = listener(message)
          if (result !== undefined)
            return await result
        }
        return undefined
      }),
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => unknown) => {
          fake.listeners.add(listener)
        }),
        removeListener: vi.fn((listener: (message: unknown) => unknown) => {
          fake.listeners.delete(listener)
        }),
      },
    },
  },
}))

beforeEach(() => {
  fake.listeners.clear()
})

describe('callBackground', () => {
  it('把 data 交给后台 handler，并拿回它的返回值', async () => {
    handleBackgroundRequests({
      'ai-match': (data: unknown) => ({ ok: true, data }),
    })

    const res = await callBackground<{ ok: boolean, data: { job: string } }>(
      'ai-match',
      { job: '前端工程师' },
    )

    expect(res).toEqual({ ok: true, data: { job: '前端工程师' } })
  })

  it('后台没响应时抛出可读的错误，而不是把 undefined 漏给调用方', async () => {
    await expect(callBackground('get-records')).rejects.toThrow('后台没有响应')
  })

  it('未注册的消息 id 会拒绝，并提示「后台可能还是旧的」', async () => {
    handleBackgroundRequests({})
    await expect(callBackground('nope')).rejects.toThrow('后台没有注册消息')
    // 这个错几乎只出现在「页面已更新、后台没重载」时，提示必须能让人自己修好
    await expect(callBackground('nope')).rejects.toThrow('重新加载一次本扩展')
  })

  it('两个页面各问各的，互不影响', async () => {
    handleBackgroundRequests({
      echo: (data: unknown) => data,
    })

    const [a, b] = await Promise.all([callBackground('echo', 'A'), callBackground('echo', 'B')])

    expect(a).toBe('A')
    expect(b).toBe('B')
  })

  it('忽略不是本扩展格式的消息', async () => {
    const handler = vi.fn()
    handleBackgroundRequests({ ping: handler })

    // 其它来源（或旧版本）的消息不该被当成请求处理
    expect(await browser.runtime.sendMessage({ hello: 'world' })).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('broadcastToPages / onPageBroadcast', () => {
  it('广播能送达订阅者，注销后不再收到', async () => {
    const onChange = vi.fn()
    const stop = onPageBroadcast<{ job: string }>('job-changed', onChange)

    broadcastToPages('job-changed', { job: '岗位 A' })
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ job: '岗位 A' }))

    stop()
    broadcastToPages('job-changed', { job: '岗位 B' })
    await Promise.resolve()

    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('只回调订阅的那个 id', async () => {
    const onChange = vi.fn()
    onPageBroadcast('job-changed', onChange)

    broadcastToPages('other-event', { job: '岗位 A' })
    await Promise.resolve()

    expect(onChange).not.toHaveBeenCalled()
  })
})
