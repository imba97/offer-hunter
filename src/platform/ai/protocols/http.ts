/**
 * 协议层共用的 HTTP 细节：地址归一化、超时、错误摘要。
 *
 * 两个协议（OpenAI / Anthropic）在这几件事上完全一致，之前各写了一份；
 * 集中到这里后，「改超时时间」这类改动不会再漏掉其中一家。
 */

/**
 * 单次对话请求的超时。
 *
 * 取 90s：正常平台 30s 内就会返回，超过这个量级基本是端点挂住或网络断了。
 * 没有超时的话 UI 会永远停在「分析中…」，用户只能刷新面板。
 */
export const AI_REQUEST_TIMEOUT_MS = 90_000

/** 连通性探测只要一句「回复 ok」，给它更短的超时 */
export const AI_PING_TIMEOUT_MS = 20_000

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * 带超时的 fetch。
 *
 * 刻意不做「用户主动取消」：请求只在超时或网络出错时结束。
 * 超时错误单独抛一句人话，让用户知道是端点没回，而不是模型判断出错。
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  }
  catch (error) {
    if (timedOut)
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）：${url}`)
    throw error
  }
  finally {
    clearTimeout(timer)
  }
}

/** 从平台的错误响应体里抽一句人话，抽不到就退回 HTTP 状态码 */
export function responseErrorDetail(raw: unknown, status: number): string {
  const detail = (raw as any)?.error?.message
  return typeof detail === 'string' && detail.length > 0 ? detail : `HTTP ${status}`
}
