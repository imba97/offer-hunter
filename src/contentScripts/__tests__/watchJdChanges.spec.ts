import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendMessage } from 'webext-bridge/content-script'
import { currentJob, watchJdChanges } from '../state'

/**
 * watchJdChanges 的行为测试。
 *
 * 这一支的核心是「JD 一变就读」——它靠 MutationObserver，而不是定时器。
 * 所以测试的关键手法是：**只推进去抖窗口（120ms），不推进兜底轮询（5s）**。
 * 如果观察器没生效，这 120ms 内不会有任何更新，测试立刻红。
 *
 * 内容脚本的 webext-bridge 依赖浏览器运行时，这里换成假的（vi.mock 会被提升到
 * import 之前，所以上面的静态 import 拿到的是 mock 版本）。
 */
vi.mock('webext-bridge/content-script', () => ({
  sendMessage: vi.fn(() => Promise.resolve()),
  onMessage: vi.fn(),
}))

function mountDetail(jd: string, title = '高级后端工程师', company = '某某科技'): void {
  document.body.innerHTML = `
    <div class="job-detail-box">
      <h1 class="job-name">${title}</h1>
      <span class="company-name">${company}</span>
      <div class="job-detail-body"><div class="desc"><p>${jd}</p></div></div>
    </div>
  `
}

/** 在**同一个容器内**改 JD —— 真实 SPA 切换岗位就是这样更新的 */
function setJd(jd: string): void {
  const desc = document.querySelector('.desc')
  if (!desc)
    throw new Error('详情容器不存在')
  desc.innerHTML = `<p>${jd}</p>`
}

let stop: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  currentJob.value = null
  vi.mocked(sendMessage).mockClear()
  // jsdom 的 visibilityState 不保证是 visible，显式放开，避免 check 被后台跳过
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})

afterEach(() => {
  stop?.()
  stop = null
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('watchJdChanges', () => {
  it('挂载后立刻读一次当前 JD', () => {
    mountDetail('岗位职责：写代码')

    stop = watchJdChanges()

    expect(currentJob.value?.jdText).toBe('岗位职责：写代码')
    expect(currentJob.value?.source).toBe('dom')
  })

  it('jd 一变就读，不需要等兜底轮询', async () => {
    mountDetail('旧 JD')
    stop = watchJdChanges()
    expect(currentJob.value?.jdText).toBe('旧 JD')

    setJd('新 JD：负责服务端架构设计')

    // 只推进去抖窗口；观察器若失效，这里什么都不会发生
    await vi.advanceTimersByTimeAsync(150)

    expect(currentJob.value?.jdText).toBe('新 JD：负责服务端架构设计')
    expect(sendMessage).toHaveBeenCalledWith('job-changed', expect.anything(), 'options')
  })

  it('dom 里读到的岗位名/公司名会带进兜底岗位', async () => {
    mountDetail('岗位职责：写代码', '资深前端工程师', '某互联网公司')

    stop = watchJdChanges()

    expect(currentJob.value?.jobName).toBe('资深前端工程师')
    expect(currentJob.value?.brandName).toBe('某互联网公司')
  })

  it('同一岗位的折叠版 JD 不会覆盖已更完整的内容', async () => {
    mountDetail('完整的 JD 正文，包含职责与要求两部分')
    stop = watchJdChanges()
    expect(currentJob.value?.jdText).toContain('完整的 JD 正文')

    // 同一岗位（URL 上没有 securityId 时按文本包含判断）被折叠成更短的版本
    setJd('完整的 JD 正文')
    await vi.advanceTimersByTimeAsync(150)

    expect(currentJob.value?.jdText).toBe('完整的 JD 正文，包含职责与要求两部分')
  })

  it('有接口数据时，认不出同一岗位就保留接口数据', async () => {
    mountDetail('岗位 A 的 JD')
    stop = watchJdChanges()

    // 模拟接口已捕获到岗位 B（与 DOM 文本互不包含）
    currentJob.value = {
      ...currentJob.value!,
      securityId: 'sid-b',
      jobName: '接口岗位 B',
      source: 'api',
      jdText: '岗位 B 的完整 JD',
    }

    setJd('岗位 C 的 JD')
    await vi.advanceTimersByTimeAsync(150)

    expect(currentJob.value?.jobName).toBe('接口岗位 B')
    expect(currentJob.value?.jdText).toBe('岗位 B 的完整 JD')
  })

  it('容器被 SPA 换掉后，兜底轮询能把观察器重新挂上', async () => {
    mountDetail('第一个岗位的 JD')
    stop = watchJdChanges()

    // 整块容器被替换：旧观察器跟着旧节点一起失效
    mountDetail('换掉的容器里的 JD')
    await vi.advanceTimersByTimeAsync(5000)

    expect(currentJob.value?.jdText).toBe('换掉的容器里的 JD')
  })
})
