import type { ChatRequest, PingResult, ResolvedConfig } from '../types'
import type { TimedResponse } from '~/platform/http'
import { responseErrorDetail } from './http'

/**
 * 协议脚手架的共用实现：**两个协议（OpenAI / Anthropic）的 chat 与 ping 除了
 * 「怎么组 URL / headers / body」和「从响应哪里取正文」之外，其余逐行相同**。
 *
 * 此前这段话在两个协议文件里各写一遍，两侧的差别只有变量名：
 *   - 计时、`try/catch` 把异常转成字符串、`[model]` 前缀
 *   - `!res.ok` 时把错误体翻译成人话
 *   - 正文为空时给可诊断的原因（而不是含糊的「空回复」）
 *   - ping 用 `max_tokens: 64` + 一句「回复 ok」
 *
 * ⚠ 这里刻意只抽**流程**，不碰 wire 格式：`build` 由各协议提供，响应取文本也由各
 *   协议提供（`textOf` / `describeEmpty`）。协议之间真正的差异全部留在协议文件里，
 *   而「怎么发、怎么判失败、怎么计时」只有这一份实现。
 */

/** 一次请求要用到的 wire 细节，由各协议提供 */
export interface ChatWire {
  /**
   * 组出这次请求。
   *
   * `ping` 为 true 时要用最小的请求体（一句话、够小的 max_tokens）—— 探测的目的是
   * 验证地址 / Key / 模型名，不需要业务参数。
   */
  build: (req: ChatRequest, config: ResolvedConfig, ping: boolean) => {
    url: string
    headers: Record<string, string>
    body: unknown
  }
  /** 从响应里抽正文 */
  textOf: (raw: unknown) => string
  /** 响应没有正文时，给出可诊断的原因 */
  describeEmpty: (raw: unknown) => string
}

/** 对话请求的超时与探测超时由调用方传（它们定义在 http.ts，各协议共用同一组值） */
export interface ChatTimeouts {
  chat: number
  ping: number
}

export function createChatRunner(
  wire: ChatWire,
  timeouts: ChatTimeouts,
  request: (url: string, init: RequestInit, timeoutMs: number) => Promise<TimedResponse>,
) {
  /**
   * 发一次请求并抽出正文。
   *
   * 错误信息统一带 `[model]` 前缀：用户配了好几个平台时，「是哪个模型报的」必须能一眼看出。
   * 空正文的判定放在这里（而不是各协议里）—— 两个协议对「空」的容忍度必须一致。
   */
  async function runChat(req: ChatRequest, config: ResolvedConfig): Promise<{ text: string, raw: unknown }> {
    const { url, headers, body } = wire.build(req, config, false)

    try {
      const res = await request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, timeouts.chat)

      const raw = res.json()
      if (!res.ok)
        throw new Error(responseErrorDetail(raw, res.status))

      const text = wire.textOf(raw)
      if (!text.trim())
        throw new Error(wire.describeEmpty(raw))

      return { text, raw }
    }
    catch (error) {
      throw new Error(`[${config.model}] ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 最小连通性探测：发一个极短的请求，验证地址 / Key / 模型名三者都对。
   *
   * ⚠ 探测**不**复用 runChat 的错误包装：这里返回 `PingResult` 而不是抛错，而且
   *   文案不该带 `[model]` 前缀（设置页的「测试连接」按钮旁边就显示着模型名，
   *   再重复一遍是噪音）。
   */
  async function runPing(config: ResolvedConfig): Promise<PingResult> {
    const started = Date.now()
    const latencyMs = () => Date.now() - started

    try {
      const { url, headers, body } = wire.build({ system: '', messages: [] }, config, true)

      const res = await request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, timeouts.ping)

      const raw = res.json()

      if (!res.ok)
        return { ok: false, error: responseErrorDetail(raw, res.status), latencyMs: latencyMs() }

      const reply = wire.textOf(raw).trim()
      if (!reply) {
        // 连通性没问题但没正文：给出可诊断的原因，而不是含糊的「空回复」
        return { ok: false, error: wire.describeEmpty(raw), latencyMs: latencyMs() }
      }

      return { ok: true, reply, latencyMs: latencyMs() }
    }
    catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: latencyMs(),
      }
    }
  }

  return { runChat, runPing }
}
