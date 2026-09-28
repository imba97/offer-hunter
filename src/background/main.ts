import type { JobRecord, JobSummary, JobView, MatchResult } from '~/logic/types'
import { onMessage, sendMessage } from 'webext-bridge/background'
import { isBossPageUrl, JOBS_PAGE_URL } from '~/logic/boss/selectors'
import { broadcastToPages, handleBackgroundRequests } from '~/logic/messaging'
import {
  ensureStorageDefaults,
  readAiSettings,
  readPromptSettings,
  readRecords,
  readResume,
  upsertRecord,
} from '~/logic/storage'
import { generateGreeting, matchJob, testAiConnection } from '~/platform/ai/matching'
import { fetchGistContent } from '~/platform/gist/gist'

/**
 * 后台 service worker。
 *
 * 职责：
 *  1. 图标点击行为 —— 判断当前标签页决定「开合侧边栏」还是「跳转职位页」
 *  2. AI 调用 —— 只在这里持有 API Key，绝不下发到页面上下文；
 *     且 SW 有 host_permissions 的跨源豁免，不受 CORS 约束
 *  3. 账本读写
 *  4. **为侧边栏转发请求到内容脚本** —— 侧边栏没有页面访问权，
 *     而 /wapi/ 接口必须携带页面 Cookie，只能由内容脚本代发
 *  5. GitHub Gist 拉取 —— 简历可以放在 Gist 里（见 platform/gist/gist.ts，无需凭据）
 *
 * 两条消息通道，按「有没有 tabId」分工，别混用：
 *  · 扩展页面（侧边栏 / 设置页）→ 后台：原生 runtime.sendMessage，
 *    见 logic/messaging.ts（用 webext-bridge 会因端点名撞车而误路由甚至报错）
 *  · 后台 ↔ 内容脚本：webext-bridge，它按 tabId 路由端口，正是这里需要的
 *
 * 不做的事：不代点发送按钮，不碰登录凭据，不逆向签名。
 */

// only on dev mode
if (import.meta.hot) {
  // @ts-expect-error for background HMR
  import('/@vite/client')
  // load latest content script
  import('./contentScriptHMR')
}

/**
 * 每次都补齐存储默认值。
 *
 * 不只在 onInstalled 里做：历史数据可能字段不全（早期版本的存储格式），
 * 而这些数据已经在用户机器上，onInstalled 不会再触发。
 */
ensureStorageDefaults().catch((error) => {
  console.error('[offer-hunter] 初始化默认设置失败', error)
})

browser.runtime.onInstalled.addListener((): void => {
  ensureStorageDefaults().catch((error) => {
    console.error('[offer-hunter] 初始化默认设置失败', error)
  })
  // eslint-disable-next-line no-console
  console.log('Offer Hunter installed')
})

/**
 * 让点击工具栏图标 = 开合侧边栏。
 *
 * 这是浏览器原生能力：面板已打开时再点图标会收起，正好是「展开、收起」的语义，
 * 无需自己维护开合状态，也不存在定位与遮挡问题。
 *
 * 注意 `openPanelOnActionClick` 需要 Chrome 116+，且仍标注为开发者预览；
 * 老版本上该调用会失败（已 catch），此时只能从浏览器自带的侧边栏按钮打开。
 */
const chromeSidePanel = (browser as any).sidePanel

if (chromeSidePanel?.setPanelBehavior) {
  chromeSidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => console.error('[offer-hunter] setPanelBehavior 失败', error))
}

/**
 * 点击图标时若不在 BOSS 页面，则跳转到职位页。
 *
 * 在 BOSS 页面上不做任何事 —— 让 setPanelBehavior 的原生开合逻辑生效。
 */
browser.action.onClicked.addListener(async (tab) => {
  try {
    if (isBossPageUrl(tab.url))
      return
    await browser.tabs.create({ url: JOBS_PAGE_URL })
  }
  catch (error) {
    console.error('[offer-hunter] action click failed', error)
  }
})

// ---------------------------------------------------------------------------
// 转发：侧边栏 → 内容脚本
// ---------------------------------------------------------------------------

/**
 * 找到目标标签页并发消息。
 *
 * 优先当前窗口的活动标签；若它不是 BOSS 页面，则回退到任意一个 BOSS 标签页 ——
 * 用户可能把侧边栏停在一边、在另一个标签里操作。
 */
async function findTargetTabId(): Promise<number | null> {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true })
  if (active?.id !== undefined && isBossPageUrl(active.url))
    return active.id

  const all = await browser.tabs.query({ url: '*://*.zhipin.com/*' })
  const first = all.find(t => t.id !== undefined)
  return first?.id ?? null
}

async function relayToContent<T>(
  messageId: string,
  data: unknown,
): Promise<{ ok: true, value: T } | { ok: false, reason: string }> {
  const tabId = await findTargetTabId()
  if (tabId === null)
    return { ok: false, reason: '没有找到 BOSS 直聘页面，请先打开职位页' }

  try {
    const value = await sendMessage(messageId as never, data as never, {
      context: 'content-script',
      tabId,
    }) as T
    return { ok: true, value }
  }
  catch (error) {
    const detail = errorText(error)
    return { ok: false, reason: `页面通信失败：${detail}（可尝试刷新 BOSS 页面）` }
  }
}

async function onRelayCurrentJob(data: { force?: boolean }) {
  const res = await relayToContent<{ job: JobView | null, url: string }>(
    'request-current-job',
    { force: Boolean(data?.force) },
  )
  if (!res.ok)
    return { ok: false as const, reason: res.reason }
  return { ok: true as const, job: res.value?.job ?? null }
}

async function onRelayDiagnostic() {
  const res = await relayToContent<unknown>('run-diagnostic', {})
  if (!res.ok)
    return { ok: false as const, reason: res.reason }
  return { ok: true as const, result: res.value as never }
}

/**
 * 内容脚本推来「岗位已变化」，转成广播发给所有扩展页面。
 *
 * 内容脚本那一段仍走 webext-bridge（按 tabId 路由，可靠）；到这里之后改用广播：
 * 侧边栏每个窗口一个，广播不需要知道谁是谁，也不会因为某个页面关闭而丢订阅。
 */
onMessage('job-changed', ({ data }) => {
  broadcastToPages('job-changed', { job: (data as { job?: JobView | null } | undefined)?.job ?? null })
})

// ---------------------------------------------------------------------------
// AI 代理
// ---------------------------------------------------------------------------

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function onAiTest() {
  try {
    const settings = await readAiSettings()
    return await testAiConnection(settings)
  }
  catch (error) {
    return { ok: false as const, error: errorText(error) }
  }
}

async function onAiMatch(data: { job: JobSummary, jdText: string }) {
  try {
    const [settings, resume, prompts] = await Promise.all([
      readAiSettings(),
      readResume(),
      readPromptSettings(),
    ])
    const result = await matchJob(
      settings,
      resume,
      data.job,
      data.jdText,
      // 用户在设置里自定义的打分口径
      { userPrompt: prompts.matchPrompt },
    )
    return { ok: true as const, data: result }
  }
  catch (error) {
    return { ok: false as const, error: errorText(error) }
  }
}

async function onAiGreeting(data: { job: JobSummary, jdText: string, match?: MatchResult | null }) {
  try {
    const [settings, resume, prompts] = await Promise.all([
      readAiSettings(),
      readResume(),
      readPromptSettings(),
    ])
    const result = await generateGreeting(
      settings,
      resume,
      data.job,
      data.jdText,
      // 带上匹配结论（若已分析过），让招呼语更贴合
      data.match ?? null,
      // 用户在设置里自定义的招呼语生成规则
      { userPrompt: prompts.greetingPrompt },
    )
    return { ok: true as const, data: result }
  }
  catch (error) {
    return { ok: false as const, error: errorText(error) }
  }
}

// ---------------------------------------------------------------------------
// GitHub Gist（简历来源）
// ---------------------------------------------------------------------------

/**
 * Gist 请求为什么也走后台：
 *
 * 与 AI 调用同一条规矩 —— 出网请求只经过后台，扩展页面侧只发消息。
 * 读 Gist 本身不需要凭据；token 是可选的，只用来把接口额度从匿名 60 次/小时
 * 提升到 5000 次/小时（见 platform/gist/gist.ts）。
 */
async function onGistFetch(data: { gistId?: string, fileName?: string, token?: string }) {
  try {
    return {
      ok: true as const,
      ...await fetchGistContent({
        gistId: data?.gistId ?? '',
        fileName: data?.fileName ?? '',
        token: data?.token ?? '',
      }),
    }
  }
  catch (error) {
    return { ok: false as const, error: errorText(error) }
  }
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

async function onGetRecords() {
  return await readRecords()
}

async function onUpsertRecord(data: JobRecord) {
  await upsertRecord(data)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 扩展页面 → 后台 的消息注册
// ---------------------------------------------------------------------------

/**
 * 侧边栏与设置页都走这条通道（原生 runtime.sendMessage，一问一答）。
 *
 * ⚠ 这张表必须在 service worker 顶层同步注册：MV3 唤醒 SW 的那条消息，
 * 只有「启动期间就注册好的监听器」能收到。
 */
handleBackgroundRequests({
  'ai-test': () => onAiTest(),
  'ai-match': data => onAiMatch(data),
  'ai-greeting': data => onAiGreeting(data),
  'gist-fetch': data => onGistFetch(data),
  'get-records': () => onGetRecords(),
  'upsert-record': data => onUpsertRecord(data),
  'relay-current-job': data => onRelayCurrentJob(data),
  'relay-diagnostic': () => onRelayDiagnostic(),
})
