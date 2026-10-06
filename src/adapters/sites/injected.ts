/**
 * MAIN world 注入脚本的**站点无关**主体。
 *
 * 运行在页面自身的 JS 上下文里（不是扩展的隔离世界），因此可以 hook 页面的
 * fetch / XMLHttpRequest，被动捕获招聘网站自己的接口响应 —— 这样零额外请求、
 * 天然携带页面签名与 Cookie，也不会因为接口改版而漏数据。
 *
 * 每个站点由 vite.config.injected.mts 用它自己的适配器单独打包一份
 * （见 sites/<id>/injected.ts），因此这里不知道任何具体站点的接口路径。
 *
 * 与隔离世界的通信只走 window.postMessage（MAIN world 拿不到 browser API）。
 *
 * ⚠ 所有 hook 必须容错：注入脚本一旦抛错就会破坏宿主页面的正常功能。
 */

/* eslint-disable no-console */

export interface CapturedApi {
  url: string
  ok: boolean
  keys: string[]
  error?: string
  ts: number
}

const CHANNEL = '__offer_hunter__'
/** 只保留最近若干条，避免长会话内存膨胀 */
const MAX_CAPTURED = 50

export interface InjectedOptions {
  /**
   * 需要被动捕获的接口路径片段（来自站点适配器的 manifest.watchedApiPaths）。
   *
   * 只捕获这些路径：别的响应连 clone().json() 都不做，对宿主页面的开销最小。
   */
  watchedApiPaths: string[]
}

export function installInjectedCapture(options: InjectedOptions): void {
  const WATCHED = options.watchedApiPaths

  const captured: CapturedApi[] = []

  /**
   * 最近一次成功捕获的详情响应。
   *
   * 必须缓存：本脚本在 document_start 就装好 hook，而隔离世界的内容脚本要到
   * document_idle 才装监听 —— 直链打开岗位详情页时响应往往正好落在这个空档里，
   * 只能靠隔离世界上来主动要一次快照补回。
   */
  let lastDetail: { url: string, data: unknown } | null = null

  function post(payload: Record<string, unknown>): void {
    try {
      window.postMessage({ channel: CHANNEL, ...payload }, window.location.origin)
    }
    catch {
      // 忽略：postMessage 失败不应影响宿主页面
    }
  }

  function isWatched(url: string): boolean {
    return WATCHED.some(w => url.includes(w))
  }

  function remember(entry: CapturedApi): void {
    captured.push(entry)
    if (captured.length > MAX_CAPTURED)
      captured.shift()
  }

  function record(
    url: string,
    ok: boolean,
    data: unknown,
    error?: string,
  ): void {
    if (!isWatched(url))
      return

    let keys: string[] = []

    try {
      const zpData = (data as any)?.zpData
      if (zpData && typeof zpData === 'object')
        keys = Object.keys(zpData).slice(0, 20)
      else if (data && typeof data === 'object')
        keys = Object.keys(data).slice(0, 20)
    }
    catch {
      // 忽略
    }

    remember({ url, ok, keys, error, ts: Date.now() })

    if (ok && data && isWatched(url))
      lastDetail = { url, data }

    post({
      type: 'api',
      url,
      ok,
      keys,
      error,
      data: ok ? data : undefined,
    })

    if (__DEV__)
      console.debug('[offer-hunter:main] captured', url, ok ? 'ok' : error)
  }

  // -------------------------------------------------------------------------
  // fetch hook
  // -------------------------------------------------------------------------

  const originalFetch = window.fetch

  window.fetch = function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const promise = originalFetch.apply(this, [input, init] as any)

    try {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url

      if (!isWatched(url))
        return promise

      promise
        .then((res) => {
          // 在 then 里就发起 clone().json()，保持与页面自身的消费时序一致
          return res.clone().json().then((data) => {
            record(url, res.ok, data)
          }).catch((e) => {
            record(url, false, null, `parse: ${String(e)}`)
          })
        })
        .catch((e) => {
          record(url, false, null, `fetch: ${String(e)}`)
        })
    }
    catch (e) {
      record('unknown', false, null, `hook: ${String(e)}`)
    }

    return promise
  } as typeof window.fetch

  // -------------------------------------------------------------------------
  // XMLHttpRequest hook（部分接口走 XHR）
  // -------------------------------------------------------------------------

  const XHR = XMLHttpRequest.prototype
  const originalOpen = XHR.open
  const originalSend = XHR.send

  XHR.open = function patchedOpen(
    this: XMLHttpRequest & { __ohUrl?: string },
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      this.__ohUrl = typeof url === 'string' ? url : url.href
    }
    catch {
      // 忽略
    }
    return (originalOpen as any).apply(this, [method, url, ...rest])
  }

  XHR.send = function patchedSend(
    this: XMLHttpRequest & { __ohUrl?: string },
    ...args: unknown[]
  ) {
    try {
      const url = this.__ohUrl
      if (url && isWatched(url)) {
        this.addEventListener('load', () => {
          try {
            const data = JSON.parse(this.responseText)
            const ok = this.status >= 200 && this.status < 300
            record(url, ok, data)
          }
          catch (e) {
            record(url, false, null, `parse: ${String(e)}`)
          }
        })
      }
    }
    catch {
      // 忽略
    }
    return (originalSend as any).apply(this, args)
  }

  // -------------------------------------------------------------------------
  // 接收隔离世界的请求
  // -------------------------------------------------------------------------

  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window)
      return
    const msg = ev.data
    if (!msg || msg.channel !== CHANNEL)
      return

    if (msg.type === 'get-captured') {
      post({
        type: 'captured-snapshot',
        requestId: msg.requestId,
        entries: captured.map(c => ({
          url: c.url,
          ok: c.ok,
          keys: c.keys,
          error: c.error,
        })),
        // 连同最近一次详情响应一起给出去：隔离世界正是靠它补上装载前的空档
        lastDetail,
      })
    }
  })

  post({ type: 'ready' })
}
