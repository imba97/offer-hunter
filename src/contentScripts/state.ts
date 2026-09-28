import type { JobView } from '~/logic/types'
import { reactive } from 'vue'
import { sendMessage } from 'webext-bridge/content-script'
import { JOB_DETAIL_API, toJobView } from '~/logic/boss/api'
import { buildDomFallbackJob, getJdElement, readJdFromDom, readJobOutlineFromDom } from '~/logic/boss/dom'
import { JOB_DETAIL_BOX, securityIdFromUrl } from '~/logic/boss/selectors'

/**
 * 内容脚本内的共享状态。
 *
 * 单独成模块是为了让入口与轮询逻辑共用同一份状态（放在 index.ts 里会形成循环依赖）。
 *
 * 核心概念：**只有一个「当前岗位」**。用户自己在 BOSS 页面上点击岗位卡片，
 * 扩展捕获详情接口、更新这个岗位，面板只展示并分析它。不遍历列表、不做队列。
 *
 * ⚠ 界面全部在侧边栏，这里只保留「页面侧真正会用到」的状态：
 * 岗位与接口捕获记录。曾经的 panelState / records / busy / notice / diagnostic
 * 是给页面内悬浮面板用的，面板搬走后它们只是白占内容脚本的体积。
 */

export interface CapturedEntry {
  url: string
  ok: boolean
  keys: string[]
  error?: string
}

const INJECTED_CHANNEL = '__offer_hunter__'

/** 当前正在查看的岗位（含 JD），null 表示用户还没点开任何岗位 */
export const currentJob = reactive<{ value: JobView | null }>({ value: null })

/** 本会话捕获到的接口记录，用于诊断 */
export const capturedApis = reactive<CapturedEntry[]>([])

interface InjectedMessage {
  channel: string
  type: string
  url?: string
  ok?: boolean
  keys?: string[]
  error?: string
  data?: unknown
  entries?: CapturedEntry[]
  /** 注入脚本缓存下来、还没来得及送出的最近一次详情响应 */
  lastDetail?: { url: string, data?: unknown } | null
}

/**
 * 通知后台「岗位已变化」，由后台广播给各扩展页面（侧边栏每个窗口一个）。
 *
 * 以前是直接发给 'options' 端点，但那是后台里侧边栏与设置页共用的槽位：
 * 只会送到其中一个页面，另一个窗口的侧边栏永远收不到推送。
 * 侧边栏没打开时这条消息会失败 —— 那是正常情况，静默忽略。
 */
function notifyJobChanged(job: JobView | null): void {
  sendMessage('job-changed', { job }, 'background').catch(() => {})
}

/** 请求注入脚本回传一次已捕获接口的快照 */
export function requestCapturedSnapshot(): void {
  window.postMessage(
    { channel: INJECTED_CHANNEL, type: 'get-captured', requestId: Date.now() },
    window.location.origin,
  )
}

/**
 * 用捕获到的详情响应更新当前岗位。
 *
 * 返回是否真的发生了更新。
 *
 * 判重条件是「同一 securityId **且已有数据来自接口**」：只按 securityId 判重会
 * 让「先从 DOM 兜底、随后接口才捕获到」的岗位永远停留在兜底数据上
 * （面板显示占位标题、薪资为空），而这些都是接口才能给的。
 */
function applyJobView(zpData: unknown, securityId: string): boolean {
  const view = toJobView(zpData, securityId)
  if (!view)
    return false

  const existing = currentJob.value
  if (existing?.source === 'api' && existing.securityId && existing.securityId === view.securityId)
    return false

  currentJob.value = view
  return true
}

function mergeCapturedEntries(entries: CapturedEntry[]): void {
  for (const entry of entries) {
    const idx = capturedApis.findIndex(a => a.url === entry.url)
    if (idx === -1)
      capturedApis.push(entry)
    else
      capturedApis[idx] = entry
  }
}

/** 在窗口上挂监听，接收 MAIN world 注入脚本的数据 */
export function installInjectedListener(): void {
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window)
      return

    const msg = ev.data as InjectedMessage
    if (!msg || msg.channel !== INJECTED_CHANNEL)
      return

    if (msg.type === 'ready') {
      // 注入脚本可能比我们早执行完，主动要一次快照
      requestCapturedSnapshot()
      return
    }

    /*
     * 快照：用来补上「隔离世界装载之前就已经发完」的那些请求 ——
     * 直链打开 `…/job?securityId=xxx` 时，详情响应往往在 document_start 之后、
     * document_idle 之前就回来了，被动监听根本来不及挂上。
     */
    if (msg.type === 'captured-snapshot') {
      if (Array.isArray(msg.entries))
        mergeCapturedEntries(msg.entries)

      const data = msg.lastDetail?.data
      if (data && !currentJob.value) {
        const securityId = msg.lastDetail?.url
          ? securityIdFromUrl(msg.lastDetail.url)
          : ''
        if (applyJobView((data as any)?.zpData, securityId))
          notifyJobChanged(currentJob.value)
      }
      return
    }

    if (msg.type !== 'api' || !msg.url)
      return

    const entry: CapturedEntry = {
      url: msg.url,
      ok: Boolean(msg.ok),
      keys: msg.keys ?? [],
      error: msg.error,
    }
    mergeCapturedEntries([entry])

    if (msg.ok && msg.url.includes(JOB_DETAIL_API) && msg.data) {
      const securityId = securityIdFromUrl(msg.url)
      if (applyJobView((msg.data as any)?.zpData, securityId)) {
        // eslint-disable-next-line no-console
        console.info('[offer-hunter] 已更新当前岗位')
        notifyJobChanged(currentJob.value)
      }
    }
  })

  // 注入脚本在 document_start 跑，本脚本在 document_idle 才装监听：
  // 上面的 'ready' 早就发过了，所以这里必须主动要一次快照，否则那段捕获全丢。
  requestCapturedSnapshot()
}

/** 兜底轮询间隔：观察器失联（SPA 换节点）或漏事件时把状态追回来 */
const JD_FALLBACK_POLL_MS = 5000
/** 详情容器还没渲染出来时的重试间隔 */
const JD_ATTACH_RETRY_MS = 500
/** 突变合并窗口：一次渲染会产生几十条记录，没必要每条都去读一遍文本 */
const JD_MUTATION_DEBOUNCE_MS = 120

/**
 * 判断新读到的 JD 与已有岗位是否属于同一个岗位。
 *
 * 优先用 URL 上的 securityId（详情页地址就带着它）；拿不到时退回文本比对 ——
 * 接口 JD（postDescription）与 DOM 渲染出来的 JD 在换行/分段上未必一致，
 * 因此用「互相包含」而不是相等。
 */
function isSameJob(existing: JobView, jd: string): boolean {
  const securityId = securityIdFromUrl(window.location.href)
  if (securityId)
    return securityId === existing.securityId
  if (!existing.jdText)
    return true
  return jd.includes(existing.jdText) || existing.jdText.includes(jd)
}

/**
 * DOM 回退：监听详情面板里的 JD 文本变化。
 *
 * 触发方式：**MutationObserver 为主**（JD 一变就读，不再有定时器盲区），
 * 5s 兜底轮询负责「容器被 SPA 换掉、观察器失联」这类情况；
 * 容器尚未渲染时用 500ms 的小间隔重试挂载。
 *
 * 三条规则，都是为了避免「用不可靠的数据覆盖可靠的数据」：
 *  1. **不降级**：同一岗位时，只有新文本更完整才覆盖（DOM 常常是折叠/截断版）
 *  2. **不丢身份**：已有接口数据时，认不出是同一岗位就原样保留 —— 宁可显示旧岗位，
 *     也不要把新 JD 记到旧岗位的账本上（那会污染去重依据）
 *  3. **不错认岗位**：只有 DOM 数据之间切换时才重置身份，并带上 URL 上的 securityId
 */
export function watchJdChanges(): () => void {
  let lastSignature = ''
  let lastJd = ''
  let observer: MutationObserver | null = null
  let observedBox: Element | null = null
  let attachTimer: number | null = null
  let debounceTimer: number | null = null

  const check = () => {
    // 页面在后台时不必读（重新可见后由兜底轮询补上）
    if (document.hidden)
      return

    const el = getJdElement()
    if (!el)
      return

    /*
     * 廉价前置判断：只读长度与首尾片段。
     * 读 textContent 不触发样式计算，而下面的 extractCleanText 要克隆节点并对
     * 每个元素取计算样式 —— 绝大多数突变都会在这里被挡掉。
     */
    const raw = el.textContent ?? ''
    if (!raw)
      return
    const signature = `${raw.length}|${raw.slice(0, 40)}|${raw.slice(-20)}`
    if (signature === lastSignature)
      return
    lastSignature = signature

    const jd = readJdFromDom()
    if (!jd || jd === lastJd)
      return
    lastJd = jd

    const existing = currentJob.value
    const sameJob = existing ? isSameJob(existing, jd) : false

    if (existing && !sameJob && existing.source === 'api') {
      // eslint-disable-next-line no-console
      console.info('[offer-hunter] DOM 里的 JD 与已捕获的岗位不一致，保留接口数据')
      return
    }

    const outline = readJobOutlineFromDom()

    if (existing && sameJob) {
      if (jd.length <= existing.jdText.length)
        return
      currentJob.value = buildDomFallbackJob(jd, existing, outline)
    }
    else {
      // 此前没有岗位，或是在 DOM 数据之间切换：重置身份，只带 URL 上的 securityId
      const securityId = securityIdFromUrl(window.location.href)
      currentJob.value = buildDomFallbackJob(jd, securityId ? { securityId } : null, outline)
    }

    // eslint-disable-next-line no-console
    console.info('[offer-hunter] 从 DOM 回退更新了 JD')
    notifyJobChanged(currentJob.value)
  }

  /** 合并短时间内的多次突变 */
  const scheduleCheck = () => {
    if (debounceTimer !== null)
      return
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null
      check()
    }, JD_MUTATION_DEBOUNCE_MS)
  }

  /**
   * 让观察器盯上详情容器。
   *
   * 返回是否已挂上：容器还没渲染出来、或已被 SPA 换掉（旧节点脱离文档）时返回 false，
   * 交给重试/兜底轮询处理。
   */
  const ensureObserver = (): boolean => {
    const box = document.querySelector(JOB_DETAIL_BOX)
    if (!box)
      return false
    if (observer && observedBox === box && box.isConnected)
      return true

    observer?.disconnect()
    observer = new MutationObserver(scheduleCheck)
    observer.observe(box, { childList: true, subtree: true, characterData: true })
    observedBox = box
    return true
  }

  const startAttachRetry = () => {
    if (attachTimer !== null)
      return
    attachTimer = window.setInterval(() => {
      if (!ensureObserver())
        return
      if (attachTimer !== null) {
        window.clearInterval(attachTimer)
        attachTimer = null
      }
      check()
    }, JD_ATTACH_RETRY_MS)
  }

  // 兜底轮询只在观察器不可用时起作用，间隔可以放长
  const pollTimer = window.setInterval(() => {
    if (!ensureObserver()) {
      startAttachRetry()
      return
    }
    check()
  }, JD_FALLBACK_POLL_MS)

  if (!ensureObserver())
    startAttachRetry()
  else
    check()

  return () => {
    observer?.disconnect()
    observer = null
    observedBox = null
    window.clearInterval(pollTimer)
    if (attachTimer !== null)
      window.clearInterval(attachTimer)
    if (debounceTimer !== null)
      window.clearTimeout(debounceTimer)
  }
}
