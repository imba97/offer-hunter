import type { JobCore, JobRecord, JobView, MatchResult } from '~/logic/types'
import { onMessage, sendMessage } from 'webext-bridge/background'
import { broadcastToPages, handleBackgroundRequests } from '~/logic/messaging'
import { getResumeSource } from '~/logic/resume-sources/registry'
import {
  ensureStorageDefaults,
  readAiSettings,
  readPromptSettings,
  readRecords,
  readResume,
  upsertRecord,
} from '~/logic/storage'
import { generateGreeting, matchJob, testAiConnection } from '~/platform/ai/matching'
import { detectSite, SITE_DESCRIPTORS } from '~/sites/routing'

/**
 * 后台 service worker。
 *
 * 职责：
 *  1. 图标点击行为 —— 判断当前标签页决定「开合侧边栏」还是「跳转职位页」
 *  2. AI 调用 —— 只在这里持有 API Key，绝不下发到页面上下文；
 *     且 SW 有 host_permissions 的跨源豁免，不受 CORS 约束
 *  3. 账本读写
 *  4. **为侧边栏转发请求到内容脚本** —— 侧边栏没有页面访问权，
 *     而需要页面 Cookie 的接口只能由内容脚本代发（见站点适配器的 needsPageCookie）
 *  5. 简历来源取数（可插拔，见 logic/resume-sources）
 *
 * ⚠ 本文件**不得出现任何具体站点名或域名**：站点判断一律经 sites/registry。
 *   这是「加第二个招聘网站时这里不用改」的保证。
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
 * 点击图标时若不在任何支持的招聘网站上，则跳转到职位页。
 *
 * 在支持的站点上不做任何事 —— 让 setPanelBehavior 的原生开合逻辑生效。
 */
browser.action.onClicked.addListener(async (tab) => {
  try {
    if (detectSite(tab.url))
      return
    // 单站点时就是它的职位页；多站点时取第一个（用户可在设置里再切）
    const target = SITE_DESCRIPTORS[0]
    if (target)
      await browser.tabs.create({ url: target.jobsPageUrl })
  }
  catch (error) {
    console.error('[offer-hunter] action click failed', error)
  }
})

// ---------------------------------------------------------------------------
// 转发：侧边栏 → 内容脚本
// ---------------------------------------------------------------------------

/**
 * 转发消息给**指定标签页**的内容脚本。
 *
 * ⚠ 目标标签页由**面板**决定（消息里带 tabId），后台不自己去找。
 *
 * 这里曾经是「先看本窗口活动标签，不是站点就全局找任意一个站点标签页」。
 * 那个全局回退造成一个用户可见的 bug：从 BOSS 职位页切到别的页面后，
 * 面板仍然显示着岗位 —— 后台从另一个残留的站点标签页把岗位取回来了。
 * 面板表达的是「你现在看的这个标签页上的岗位」，跟着别的标签页走是错的。
 *
 * 现在面板先确认自己那个标签页是本站点，再把 tabId 交过来；
 * 两边口径完全一致，不可能再各说各话。
 */
async function relayToContent<T>(
  messageId: string,
  data: unknown,
  tabId: number | undefined,
): Promise<{ ok: true, value: T } | { ok: false, reason: string }> {
  if (typeof tabId !== 'number')
    return { ok: false, reason: '面板没有给出目标标签页' }

  try {
    const value = await sendMessage(messageId as never, data as never, {
      context: 'content-script',
      tabId,
    }) as T
    return { ok: true, value }
  }
  catch (error) {
    const detail = errorText(error)
    return { ok: false, reason: `页面通信失败：${detail}（可尝试刷新页面）` }
  }
}

async function onRelayCurrentJob(data: { force?: boolean, tabId?: number }) {
  const res = await relayToContent<{ job: JobView | null, url: string }>(
    'request-current-job',
    { force: Boolean(data?.force) },
    data?.tabId,
  )
  if (!res.ok)
    return { ok: false as const, reason: res.reason }
  return { ok: true as const, job: res.value?.job ?? null }
}

async function onRelayDiagnostic(data: { tabId?: number }) {
  const res = await relayToContent<unknown>('run-diagnostic', {}, data?.tabId)
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

async function onAiMatch(data: { job: JobCore, jdText: string }) {
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

async function onAiGreeting(data: { job: JobCore, jdText: string, match?: MatchResult | null }) {
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
// 简历来源（可插拔）
// ---------------------------------------------------------------------------

/**
 * 简历来源的取数为什么也走后台：
 *
 * 与 AI 调用同一条规矩 —— 出网请求只经过后台，扩展页面侧只发消息。
 * 后台有 host_permissions 的跨源豁免，且凭据（如 Gist token）不必下发到页面。
 *
 * 这条消息是**按注册表路由**的，而不是给每个来源写一条：
 * 新增简历来源只加一个适配器文件 + 注册一行，本文件不用改。
 * 消息名形如 `resume-source:fetch`，data 里带 `sourceId` 选适配器。
 */
async function onResumeSourceFetch(data: { sourceId?: string, config?: Record<string, unknown> }) {
  const adapter = getResumeSource(data?.sourceId ?? '')
  if (!adapter) {
    return { ok: false as const, error: `未知的简历来源：${data?.sourceId ?? '(空)'}` }
  }

  try {
    return { ok: true as const, content: await adapter.fetch(data?.config ?? {}) }
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
  'resume-source:fetch': data => onResumeSourceFetch(data),
  'get-records': () => onGetRecords(),
  'upsert-record': data => onUpsertRecord(data),
  'relay-current-job': data => onRelayCurrentJob(data),
  'relay-diagnostic': data => onRelayDiagnostic(data),
})
