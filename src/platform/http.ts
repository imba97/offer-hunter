/**
 * 平台层的 HTTP 公共件。
 *
 * 目前只有「带超时的请求」，但两个消费方（AI 协议层、GitHub Gist 同步）都需要它，
 * 所以它不该挂在 `adapters/ai/protocols/` 下面 —— 那是 AI 自己的协议细节。
 */

/**
 * 一次请求的结果。
 *
 * ⚠ 这里刻意**不是 `Response`**：超时必须盖住「读响应体」这一步，而 `Response` 的
 *   body 是调用方在函数外读的 —— 那样 `fetchWithTimeout` 只能在收到响应头时就放掉
 *   定时器，端点发完头再卡住就没人管了（真机症状：面板永远停在「分析中…」）。
 *   因此读文本这件事被收进本函数内部，读完才返回。
 *
 * 于是「先看状态码、再解析 json」的用法变成了：
 *
 *   const res = await requestWithTimeout(url, init, timeoutMs)
 *   if (!res.ok) throw new Error(responseErrorDetail(res.json(), res.status))
 */
export interface TimedResponse {
  ok: boolean
  status: number
  headers: Headers
  /** 响应体原文（已被完整读取） */
  text: string
  /** 尽力解析 JSON；不是 JSON 就返回 null（HTML 错误页等） */
  json: () => unknown
}

/**
 * 带超时的请求，**超时覆盖到响应体读完为止**。
 *
 * 刻意不做「用户主动取消」：请求只在超时或网络出错时结束。
 * 超时错误单独抛一句人话，让用户知道是端点没回，而不是模型判断出错。
 */
export async function requestWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<TimedResponse> {
  const controller = new AbortController()
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    // ⚠ 读 body 必须在 try 内：它同样受这次超时保护（见文件头）
    const text = await res.text()

    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text,
      json: () => {
        try {
          return JSON.parse(text)
        }
        catch {
          return null
        }
      },
    }
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
