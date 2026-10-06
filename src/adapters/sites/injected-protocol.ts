/**
 * 注入脚本（MAIN world）与内容脚本（隔离世界）之间的**线协议**。
 *
 * 两侧通过 `window.postMessage` 通信（MAIN world 拿不到 browser API），而这段协议
 * 以前是**在两边各写一份、靠人肉对齐**的：通道名是同一个字面量抄两遍，载荷形状一边
 * 用 interface 声明、另一边手搓对象字面量。改一处忘另一处的症状是**静默失效**
 * —— `postMessage` 失败被 `try/catch` 吞掉，页面上什么都不报，只是岗位再也不更新。
 *
 * 因此把通道名与每种消息的形状都收在这里。两个 bundle 各自 import 它：
 * 本文件是**纯类型 + 常量**，没有任何运行时依赖，注入脚本与内容脚本都能安全引用。
 */

/** postMessage 的通道名：两侧必须完全一致，所以只在这里出现一次 */
export const INJECTED_CHANNEL = '__offer_hunter__'

/**
 * 一条捕获记录（注入脚本侧的形状，带时间戳）。
 *
 * ⚠ 与下面 `InjectedEntry` 的区别是 `ts`：时间戳只对 MAIN world 自己有用
 *   （它用来做「最近若干条」的裁剪），发消息时**刻意不传**，免得把内部状态
 *   泄漏进线协议。要让两侧共用一个类型就得接受这点冗余。
 */
export interface CapturedApi {
  url: string
  ok: boolean
  keys: string[]
  error?: string
  ts: number
}

/** 发消息时用的捕获记录：不带时间戳 */
export interface InjectedEntry {
  url: string
  ok: boolean
  keys: string[]
  error?: string
}

/** 注入脚本发起的「我已经装好了」 —— 内容脚本收到后应答一次快照请求 */
export interface InjectedReadyMessage {
  channel: typeof INJECTED_CHANNEL
  type: 'ready'
}

/**
 * 捕获到一条被监听的接口响应。
 *
 * `data` 只在成功时带（失败的响应没有可用的正文）；内容脚本要自己判断
 * 「这条 url 是不是本站点的详情接口」（`isDetailApiUrl`），因为注入脚本
 * 不知道任何站点私有知识。
 */
export interface InjectedApiMessage {
  channel: typeof INJECTED_CHANNEL
  type: 'api'
  url: string
  ok: boolean
  keys: string[]
  error?: string
  data?: unknown
}

/**
 * 快照应答：补上「隔离世界装载之前就已经发完」的那些请求。
 *
 * 直链打开岗位详情页时，详情响应往往在 `document_start`（注入脚本启动）之后、
 * `document_idle`（内容脚本启动）之前就回来了，被动监听根本来不及挂上。
 */
export interface InjectedSnapshotMessage {
  channel: typeof INJECTED_CHANNEL
  type: 'captured-snapshot'
  requestId?: number
  entries: InjectedEntry[]
  /** 注入脚本缓存下来、还没来得及送出的最近一次详情响应 */
  lastDetail: { url: string, data: unknown } | null
}

/** 内容脚本发起：把已捕获的接口记录回传一份 */
export interface InjectedGetCapturedMessage {
  channel: typeof INJECTED_CHANNEL
  type: 'get-captured'
  requestId: number
}

/** 注入脚本 → 内容脚本的全部消息 */
export type InjectedToContentMessage
  = | InjectedReadyMessage
    | InjectedApiMessage
    | InjectedSnapshotMessage

/**
 * 同上，但去掉 `channel` —— 发消息时由 `post()` 统一补上通道名。
 *
 * ⚠ 必须逐个成员 `Omit`（用分配式条件类型），不能写成 `Omit<联合, 'channel'>`：
 *   后者会把联合**塌成公共字段**（只剩 `type`），于是「多发一个 url」这类错误
 *   反而编译不过、而真正想要的字段检查也没了。
 */
export type InjectedToContentPayload
  = InjectedToContentMessage extends infer M
    ? M extends { channel: unknown } ? Omit<M, 'channel'> : never
    : never

/** 内容脚本 → 注入脚本的全部消息 */
export type ContentToInjectedMessage = InjectedGetCapturedMessage

/** 收消息时用的联合类型（两侧都会过滤掉不认识的消息，所以这里必须有「不认识」的余地） */
export type InjectedMessage = InjectedToContentMessage | ContentToInjectedMessage

/**
 * 从 `MessageEvent.data` 里窄化出本站点的协议消息。
 *
 * 页面上别的脚本也在用 `window.postMessage`，所以「通道对不上就丢掉」这件事
 * 必须由所有收消息的地方一致地做 —— 收在这里，两个 bundle 就不会各写一遍。
 */
export function asInjectedMessage(data: unknown): InjectedMessage | null {
  const msg = data as Partial<InjectedMessage> | null
  if (!msg || msg.channel !== INJECTED_CHANNEL || typeof msg.type !== 'string')
    return null
  return msg as InjectedMessage
}
