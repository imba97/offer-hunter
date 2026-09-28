/**
 * 平台层的 HTTP 公共件。
 *
 * 目前只有「带超时的 fetch」，但两个消费方（AI 协议层、GitHub Gist 同步）都需要它，
 * 所以它不该挂在 `platform/ai/protocols/` 下面 —— 那是 AI 自己的协议细节。
 */

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
