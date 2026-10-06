import type { ResolvedConfig } from '../types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicProtocol } from '../protocols/anthropic'
import { createOpenAIProtocol } from '../protocols/openai'

/**
 * 协议层的**行为**测试。
 *
 * ⚠ 这组测试是补出来的：此前 `ping` / `chat` 一条测试都没有，只有纯函数与注册表被
 *   覆盖着 —— 而「超时怎么算、错误怎么包装、空正文怎么报」全在协议层里。抽出共用
 *   脚手架（protocols/chat.ts）时没有网，所以先把这些行为钉住，再动实现。
 *
 * 网络层用假的 `fetch`（而不是注入假的 runner）：这样测的是**从协议到 HTTP 的整条
 * 链路**，包括请求体真的长成什么样、超时真的传下去了。
 */

const CONFIG: ResolvedConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  maxTokens: 1024,
  thinking: false,
  thinkingToggle: false,
}

/**
 * 假的 fetch 响应。
 *
 * ⚠ 必须给 `text()`：超时保护要盖住「读响应体」这一步，所以 `requestWithTimeout`
 *   是在内部读 `text()` 的（见 platform/http.ts）；只给 `json()` 会直接抛错。
 */
function fakeResponse(
  body: unknown,
  { status = 200 }: { status?: number } = {},
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response
}

/** 装一个假 fetch，返回它收到的调用记录 */
function stubFetch(...responses: Response[]) {
  const calls: Array<{ url: string, init: RequestInit }> = []
  let index = 0

  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return responses[Math.min(index++, responses.length - 1)]
  }))

  return calls
}

function bodyOf(call: { init: RequestInit }): any {
  return JSON.parse(String(call.init.body))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// OpenAI 兼容协议
// ---------------------------------------------------------------------------

describe('openAI 协议：chat', () => {
  it('把 system 与消息放进请求体，并抽出正文', async () => {
    const calls = stubFetch(fakeResponse({
      choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
    }))

    const res = await createOpenAIProtocol().chat(
      { system: '你是助手', messages: [{ role: 'user', content: '在吗' }] },
      CONFIG,
    )

    expect(res.text).toBe('你好')
    expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions')
    const body = bodyOf(calls[0])
    expect(body.model).toBe('test-model')
    expect(body.max_tokens).toBe(1024)
    expect(body.messages).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '在吗' },
    ])
    // 没要求 JSON 就不该带 response_format
    expect(body.response_format).toBeUndefined()
  })

  it('要求 JSON 时带上 response_format', async () => {
    const calls = stubFetch(fakeResponse({
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
    }))

    await createOpenAIProtocol().chat(
      { system: 's', messages: [{ role: 'user', content: 'u' }], json: true },
      CONFIG,
    )

    expect(bodyOf(calls[0]).response_format).toEqual({ type: 'json_object' })
  })

  it('hTTP 失败时报错带状态码与模型名', async () => {
    stubFetch(fakeResponse('bad gateway', { status: 502 }))

    await expect(
      createOpenAIProtocol().chat({ system: 's', messages: [] }, CONFIG),
    ).rejects.toThrow('[test-model] HTTP 502')
  })

  it('平台上给的错误说明优先于状态码', async () => {
    stubFetch(fakeResponse({ error: { message: '余额不足' } }, { status: 402 }))

    await expect(
      createOpenAIProtocol().chat({ system: 's', messages: [] }, CONFIG),
    ).rejects.toThrow('[test-model] 余额不足')
  })

  it('正文被 max_tokens 截断时说明是截断，而不是含糊的解析失败', async () => {
    stubFetch(fakeResponse({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    }))

    await expect(
      createOpenAIProtocol().chat({ system: 's', messages: [] }, CONFIG),
    ).rejects.toThrow(/截断/)
  })
})

describe('openAI 协议：ping', () => {
  it('发最小请求（一句话 + 小预算）并回显', async () => {
    const calls = stubFetch(fakeResponse({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }))

    const result = await createOpenAIProtocol().ping(CONFIG)

    expect(result.ok).toBe(true)
    expect(result.reply).toBe('ok')
    expect(typeof result.latencyMs).toBe('number')

    const body = bodyOf(calls[0])
    expect(body.max_tokens).toBe(64)
    expect(body.messages).toEqual([{ role: 'user', content: '回复 ok' }])
  })

  it('不抛错，把失败包进 PingResult', async () => {
    stubFetch(fakeResponse('nope', { status: 401 }))

    const result = await createOpenAIProtocol().ping(CONFIG)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('HTTP 401')
  })

  it('连通但没正文时给出可诊断的原因', async () => {
    stubFetch(fakeResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }))

    const result = await createOpenAIProtocol().ping(CONFIG)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/截断/)
  })

  it('错误信息不带 [model] 前缀（设置页旁边就显示着模型名）', async () => {
    stubFetch(fakeResponse('nope', { status: 500 }))

    const result = await createOpenAIProtocol().ping(CONFIG)

    expect(result.error).not.toContain('[test-model]')
  })
})

// ---------------------------------------------------------------------------
// Anthropic 协议
// ---------------------------------------------------------------------------

describe('anthropic 协议：chat', () => {
  it('system 走顶层字段，messages 里不带 system，并从 content 块取正文', async () => {
    const calls = stubFetch(fakeResponse({
      content: [{ type: 'text', text: '好的' }],
      stop_reason: 'end_turn',
    }))

    const res = await createAnthropicProtocol().chat(
      {
        system: '你是助手',
        messages: [
          { role: 'system', content: '（不该出现在 messages 里）' },
          { role: 'user', content: '在吗' },
        ],
      },
      CONFIG,
    )

    expect(res.text).toBe('好的')
    expect(calls[0].url).toBe('https://api.example.com/v1/v1/messages')

    const body = bodyOf(calls[0])
    expect(body.system).toBe('你是助手')
    expect(body.messages).toEqual([{ role: 'user', content: '在吗' }])
    // 默认鉴权方式是 x-api-key
    expect(calls[0].init.headers).toMatchObject({ 'x-api-key': 'sk-test' })
  })

  it('thinking 块不算正文（混进来会污染 JSON 解析）', async () => {
    stubFetch(fakeResponse({
      content: [
        { type: 'thinking', thinking: '（推理过程）' },
        { type: 'text', text: '{"score":80}' },
      ],
      stop_reason: 'end_turn',
    }))

    const res = await createAnthropicProtocol().chat({ system: 's', messages: [] }, CONFIG)

    expect(res.text).toBe('{"score":80}')
  })

  it('被 max_tokens 截断时给出「调大预算或关思考」的提示', async () => {
    stubFetch(fakeResponse({ content: [], stop_reason: 'max_tokens' }))

    await expect(
      createAnthropicProtocol().chat({ system: 's', messages: [] }, CONFIG),
    ).rejects.toThrow(/max_tokens 截断/)
  })

  it('bearer 鉴权风格走 Authorization', async () => {
    const calls = stubFetch(fakeResponse({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))

    await createAnthropicProtocol({ authStyle: 'bearer' })
      .chat({ system: 's', messages: [] }, CONFIG)

    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBeUndefined()
  })
})

describe('anthropic 协议：ping', () => {
  it('发最小请求并回显', async () => {
    const calls = stubFetch(fakeResponse({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }))

    const result = await createAnthropicProtocol().ping(CONFIG)

    expect(result.ok).toBe(true)
    expect(result.reply).toBe('ok')
    expect(bodyOf(calls[0]).max_tokens).toBe(64)
  })

  it('truncation 在 ping 路径也给出同样的诊断', async () => {
    stubFetch(fakeResponse({ content: [], stop_reason: 'max_tokens' }))

    const result = await createAnthropicProtocol().ping(CONFIG)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/max_tokens 截断/)
  })

  it('hTTP 失败不抛错', async () => {
    stubFetch(fakeResponse('nope', { status: 429 }))

    const result = await createAnthropicProtocol().ping(CONFIG)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('HTTP 429')
  })
})
