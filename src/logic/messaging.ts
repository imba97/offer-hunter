/**
 * 扩展页面 ↔ 后台的消息通道（原生 runtime.sendMessage）。
 *
 * 为什么这条链路**不用** webext-bridge：
 * 它的后台用一张「端点名 → 端口」的表（connMap）做路由，而扩展页面的端点名是
 * **固定上下文名** —— 侧边栏没有 tabId 可拼，只能借用 `options`（设置页也用它）。
 * 于是两个页面在后台共用同一个槽位，带来两个真实故障：
 *   1. 后连上的页面把先连上的挤掉：回复被送到另一个页面，当前页面永远等不到结果
 *      （症状：点「分析」一直转圈）。
 *   2. 其中一个页面关闭时，后台按端点名把整个槽位删掉，而另一个页面的端口还活着；
 *      它之后再发消息，后台会在 `connMap.get(名字).fingerprint` 上抛
 *      "Cannot read properties of undefined (reading 'fingerprint')"，
 *      消息的处理函数根本不会执行 —— 分析、读账本全部哑火。
 *
 * 扩展页面本来就与标签页无关，一问一答用原生消息即可：请求与响应天然配对，
 * 不存在共享槽位，上述两种故障都不可能出现。
 *
 * ⚠ 内容脚本那条链路（必须按 tabId 路由）继续交给 webext-bridge，不在这里重复造轮子。
 */

/** 消息标记：只处理自己发的消息，不碰其它来源（比如将来接入的第三方消息） */
const SOURCE = 'offer-hunter'

interface RequestMessage {
  source: typeof SOURCE
  kind: 'request'
  id: string
  data?: unknown
}

interface BroadcastMessage<T = unknown> {
  source: typeof SOURCE
  kind: 'broadcast'
  id: string
  data?: T
}

type Envelope = RequestMessage | BroadcastMessage

function isEnvelope(value: unknown): value is Envelope {
  const msg = value as Partial<Envelope> | null
  return typeof msg === 'object' && msg !== null && msg.source === SOURCE
}

/**
 * 扩展页面 → 后台：发一个请求并等它的返回值。
 *
 * 两种「后台没接手」的情况都当成失败抛出，免得调用方拿到 undefined 再报更难懂的错：
 *  - 完全没有监听器（后台还没起来）：`sendMessage` 直接 reject
 *  - 有监听器但谁都没回响应：polyfill 按 Firefox 的语义 resolve 成 undefined
 */
export async function callBackground<T>(id: string, data?: unknown): Promise<T> {
  const message: RequestMessage = { source: SOURCE, kind: 'request', id, data }
  const response = await browser.runtime.sendMessage(message) as T | undefined
  if (response === undefined)
    throw new Error(`后台没有响应「${id}」，请刷新页面或重新打开侧边栏后重试`)
  return response
}

/** 页面请求的处理函数。data 由各 handler 自己收窄（与原来的 webext-bridge 写法一致） */
export type BackgroundRequestHandler = (data: any) => unknown

/**
 * 后台：注册页面请求的处理函数。
 *
 * 返回值即响应体；抛错会由 polyfill 转成 Error 抛回调用方（页面侧的 try/catch 照旧生效）。
 * ⚠ 必须在 service worker 顶层**同步**注册：MV3 只保证「启动时注册的监听器」能收到
 * 唤醒它的那条消息。
 */
export function handleBackgroundRequests(handlers: Record<string, BackgroundRequestHandler>): void {
  browser.runtime.onMessage.addListener((message: unknown) => {
    // 广播是单向通知，后台自己也会收到自己发的广播 —— 这里只处理请求
    if (!isEnvelope(message) || message.kind !== 'request')
      return undefined

    const handler = handlers[message.id]
    if (!handler)
      return Promise.reject(new Error(`后台没有注册消息：${message.id}`))

    return Promise.resolve(handler(message.data))
  })
}

/**
 * 后台 → 所有扩展页面（单向通知）。
 *
 * 用广播而不是端口：侧边栏每个窗口一个，端口就得自己维护「哪个端口属于谁」，
 * 而广播天然是「谁在听谁收到」。没有页面在听时会报「没有接收方」，属正常情况。
 */
export function broadcastToPages<T>(id: string, data?: T): void {
  const message: BroadcastMessage<T> = { source: SOURCE, kind: 'broadcast', id, data }
  browser.runtime.sendMessage(message).catch(() => {
    // 没有页面在听（侧边栏没打开）—— 推送本来就是尽力而为
  })
}

/**
 * 扩展页面：订阅后台广播，返回注销函数。
 *
 * 侧边栏页面可能被反复打开，监听器必须有明确归属，否则会累积僵尸监听器。
 */
export function onPageBroadcast<T>(id: string, callback: (data: T) => void): () => void {
  const listener = (message: unknown): void => {
    if (isEnvelope(message) && message.kind === 'broadcast' && message.id === id)
      callback(message.data as T)
  }

  browser.runtime.onMessage.addListener(listener)
  return () => browser.runtime.onMessage.removeListener(listener)
}
