import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installInjectedCapture } from '../injected'
import { INJECTED_CHANNEL } from '../injected-protocol'

/**
 * 注入脚本（MAIN world）的行为测试。
 *
 * 这一支此前**一条测试都没有**，而它有两个「错了就静默失效」的点：
 *  1. 通道名两侧必须字面一致 —— 对不上时谁都不报错，只是岗位再也不更新
 *  2. 快照必须**在收到请求后**才回（内容脚本靠它补上装载前就返回的响应）
 *
 * 所以这里从**隔离世界的视角**驱动：装好 hook，然后像内容脚本那样 postMessage 一条
 * `get-captured`，再看注入脚本回了什么。载荷形状由 injected-protocol.ts 约束，
 * 这个测试同时钉住「两侧认的是同一个通道」。
 */

/** 捕获注入脚本发出去的消息 */
const posted: any[] = []

/** 收到的最后一次请求里，我们关心的字段 */
function lastPosted(type: string): any {
  return [...posted].reverse().find(m => m?.type === type)
}

/**
 * 装一份注入脚本，并等它把 `ready` 发出来。
 *
 * `watchedApiPaths` 给一个不会命中的前缀 —— 本组测试不碰 fetch / XHR hook，
 * 只测消息这条链路。
 */
function install(): void {
  installInjectedCapture({ watchedApiPaths: ['/never-watched'] })
}

/** 模拟内容脚本发起的快照请求 */
function requestSnapshot(requestId = 1): void {
  // ⚠ 直接派发事件，而不是走 window.postMessage：本文件把 postMessage 换成了记录器
  //   （见 beforeEach），真走它的话这条请求会被记录器吞掉、进不到监听器。
  window.dispatchEvent(new MessageEvent('message', {
    data: { channel: INJECTED_CHANNEL, type: 'get-captured', requestId },
    source: window,
  }))
}

/** 派发一条来自「别人」的消息（通道或类型对不上） */
function dispatchFromOutside(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }))
}

beforeEach(() => {
  posted.length = 0
  vi.spyOn(window, 'postMessage').mockImplementation((msg: any) => {
    posted.push(msg)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('注入脚本的消息链路', () => {
  it('装好后主动报「ready」，内容脚本据此补一次快照', () => {
    install()

    expect(lastPosted('ready')).toBeTruthy()
    expect(lastPosted('ready').channel).toBe(INJECTED_CHANNEL)
  })

  it('收到 get-captured 后回一份快照（含空记录与没有详情）', () => {
    install()
    posted.length = 0

    requestSnapshot(42)

    const snapshot = lastPosted('captured-snapshot')
    expect(snapshot).toBeTruthy()
    expect(snapshot.channel).toBe(INJECTED_CHANNEL)
    // requestId 要原样带回：否则内容脚本分不清是哪次请求的应答
    expect(snapshot.requestId).toBe(42)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.lastDetail).toBeNull()
  })

  it('通道对不上的消息一律忽略（页面上别的脚本也在 postMessage）', () => {
    install()
    posted.length = 0

    dispatchFromOutside({ channel: 'someone-else', type: 'get-captured', requestId: 1 })

    expect(lastPosted('captured-snapshot')).toBeUndefined()
  })

  it('不认识的消息类型不回应（免得替别人的协议答话）', () => {
    install()
    posted.length = 0

    dispatchFromOutside({ channel: INJECTED_CHANNEL, type: 'unknown-type' })

    expect(posted).toHaveLength(0)
  })
})
