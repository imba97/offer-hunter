import type { JobSiteAdapter } from './types'
import type { DiagnosticResult } from '~/logic/types'
import { reactive } from 'vue'
import { onMessage, sendMessage } from 'webext-bridge/content-script'

/**
 * 内容脚本的**站点无关**主体。
 *
 * 每个站点的内容脚本入口只是把它自己的适配器传进来：
 *
 *   createContentScript(bossSite)
 *
 * 因此新增站点不需要复制这一整段逻辑（复制出来的那份一定会慢慢走偏）。
 * 这里只做四件事：接收注入脚本的数据、维护「当前岗位」、为侧边栏代发请求、跑诊断。
 *
 * 两条来自真机故障的硬约束：
 *
 * 1. **只有一个「当前岗位」**。用户自己在页面上点击岗位卡片，扩展捕获详情接口、
 *    更新这个岗位，面板只展示并分析它。不遍历列表、不做队列。
 * 2. **注入脚本比隔离世界早跑**（document_start vs document_idle），
 *    直链打开详情页时响应往往落在那个空档里，所以必须主动要一次快照。
 */

export interface CapturedEntry {
  url: string
  ok: boolean
  keys: string[]
  error?: string
}

const INJECTED_CHANNEL = '__offer_hunter__'

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

export function createContentScript(site: JobSiteAdapter): () => void {
  /** 当前正在查看的岗位（含 JD），null 表示用户还没点开任何岗位 */
  const currentJob = reactive<{ value: ReturnType<JobSiteAdapter['buildDomFallback']> | null }>({
    value: null,
  })

  /** 本会话捕获到的接口记录，用于诊断 */
  const capturedApis = reactive<CapturedEntry[]>([])

  /** 上次主动补拉的岗位标识与时间（见 resolveCurrentJob 的冷却逻辑） */
  let lastFetch: { key: string, at: number } | null = null

  /**
   * 通知后台「岗位已变化」，由后台广播给各扩展页面（侧边栏每个窗口一个）。
   *
   * 以前是直接发给 'options' 端点，但那是后台里侧边栏与设置页共用的槽位：
   * 只会送到其中一个页面，另一个窗口的侧边栏永远收不到推送。
   * 侧边栏没打开时这条消息会失败 —— 那是正常情况，静默忽略。
   */
  function notifyJobChanged(): void {
    // webext-bridge 按 tabId 路由，正是这里需要的
    sendMessage('job-changed', { job: currentJob.value }, 'background').catch(() => {})
  }

  /** 请求注入脚本回传一次已捕获接口的快照 */
  function requestCapturedSnapshot(): void {
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
   * 判重条件是「同一岗位标识 **且已有数据来自接口**」：只按标识判重会让
   * 「先从 DOM 兜底、随后接口才捕获到」的岗位永远停留在兜底数据上
   * （面板显示占位标题、薪资为空），而这些都是接口才能给的。
   */
  function applyApiView(payload: unknown, naturalKey: string): boolean {
    const view = site.viewFromApiPayload(payload, naturalKey)
    if (!view)
      return false

    const existing = currentJob.value
    if (existing?.source === 'api' && existing.site.naturalKey && existing.site.naturalKey === view.site.naturalKey)
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
  function installInjectedListener(): () => void {
    const onMessageFromInjected = (ev: MessageEvent): void => {
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
       * 直链打开岗位详情页时，详情响应往往在 document_start 之后、
       * document_idle 之前就回来了，被动监听根本来不及挂上。
       */
      if (msg.type === 'captured-snapshot') {
        if (Array.isArray(msg.entries))
          mergeCapturedEntries(msg.entries)

        const data = msg.lastDetail?.data
        if (data && !currentJob.value) {
          const naturalKey = msg.lastDetail?.url
            ? site.naturalKeyFromUrl(msg.lastDetail.url)
            : ''
          if (applyApiView((data as any)?.zpData, naturalKey))
            notifyJobChanged()
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

      if (msg.ok && site.isDetailApiUrl(msg.url) && msg.data) {
        const naturalKey = site.naturalKeyFromUrl(msg.url)
        if (applyApiView((msg.data as any)?.zpData, naturalKey)) {
          // eslint-disable-next-line no-console
          console.info(`[offer-hunter] 已更新当前岗位（${site.id}）`)
          notifyJobChanged()
        }
      }
    }

    window.addEventListener('message', onMessageFromInjected)

    // 注入脚本在 document_start 跑，本脚本在 document_idle 才装监听：
    // 上面的 'ready' 早就发过了，所以这里必须主动要一次快照，否则那段捕获全丢。
    requestCapturedSnapshot()

    return () => window.removeEventListener('message', onMessageFromInjected)
  }

  // -------------------------------------------------------------------------
  // DOM 兜底
  // -------------------------------------------------------------------------

  /** 兜底轮询间隔：观察器失联（SPA 换节点）或漏事件时把状态追回来 */
  const JD_FALLBACK_POLL_MS = 5000
  /** 详情容器还没渲染出来时的重试间隔 */
  const JD_ATTACH_RETRY_MS = 500
  /** 突变合并窗口：一次渲染会产生几十条记录，没必要每条都去读一遍文本 */
  const JD_MUTATION_DEBOUNCE_MS = 120

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
   *  3. **不错认岗位**：只有 DOM 数据之间切换时才重置身份，并带上 URL 上的标识
   */
  function watchJdChanges(): () => void {
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

      const probe = site.jdProbeElement()
      if (!probe)
        return

      /*
       * 廉价前置判断：只读长度与首尾片段。
       * 读 textContent 不触发样式计算，而下面的 cleanText 要克隆节点并对
       * 每个元素取计算样式 —— 绝大多数突变都会在这里被挡掉。
       */
      const raw = probe.textContent ?? ''
      if (!raw)
        return
      const signature = `${raw.length}|${raw.slice(0, 40)}|${raw.slice(-20)}`
      if (signature === lastSignature)
        return
      lastSignature = signature

      const jd = site.readJd()
      if (!jd || jd === lastJd)
        return
      lastJd = jd

      const existing = currentJob.value
      const sameJob = existing ? site.sameJob(existing, jd) : false

      if (existing && !sameJob && existing.source === 'api') {
        // eslint-disable-next-line no-console
        console.info('[offer-hunter] DOM 里的 JD 与已捕获的岗位不一致，保留接口数据')
        return
      }

      const outline = site.readOutline()

      if (existing && sameJob) {
        if (jd.length <= existing.jdText.length)
          return
        currentJob.value = site.buildDomFallback(jd, existing, outline)
      }
      else {
        // 此前没有岗位，或是在 DOM 数据之间切换：重置身份，只带 URL 上的标识
        const naturalKey = site.naturalKeyFromUrl(window.location.href)
        currentJob.value = site.buildDomFallback(
          jd,
          naturalKey ? { site: site.emptyRef(naturalKey) } : null,
          outline,
        )
      }

      // eslint-disable-next-line no-console
      console.info('[offer-hunter] 从 DOM 回退更新了 JD')
      notifyJobChanged()
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
      const box = site.jdContainerElement()
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

  // -------------------------------------------------------------------------
  // 取数与诊断
  // -------------------------------------------------------------------------

  /**
   * 读取当前岗位。
   *
   * 常规调用（`force = false`）在已有岗位时直接返回；**强制刷新**（面板上点
   * 「刷新当前岗位」）会忽略缓存重新取数 —— 否则一旦内存里是旧的/占位的岗位，
   * 面板没有任何纠正手段。
   *
   * 取数顺序：按 URL 上的标识主动补一次请求 → DOM 兜底读 JD。
   * 冷却窗口只是为了不让「岗位已下架」这类失败被反复重发。
   */
  const REFETCH_COOLDOWN_MS = 10_000

  async function resolveCurrentJob(force = false): Promise<void> {
    if (currentJob.value && !force)
      return

    const naturalKey = site.naturalKeyFromUrl(window.location.href)
    // 冷却窗口只在「同一个岗位 + 刚拉过」时起作用；强制刷新时忽略它
    const last = lastFetch
    const recentlyFetched = last !== null
      && last.key === naturalKey
      && Date.now() - last.at <= REFETCH_COOLDOWN_MS
    const shouldFetch = naturalKey.length > 0 && (!recentlyFetched || force)

    if (shouldFetch) {
      lastFetch = { key: naturalKey, at: Date.now() }
      try {
        const view = await site.fetchView(naturalKey)
        if (view) {
          currentJob.value = view
          return
        }
      }
      catch (error) {
        console.warn('[offer-hunter] 主动拉取岗位详情失败，退回 DOM 兜底', error)
      }
    }

    // DOM 兜底：文本没变就不重建（避免把接口数据的 source 降级成 dom）
    const jd = site.readJd()
    if (!jd || jd === currentJob.value?.jdText)
      return

    const base = currentJob.value?.site.naturalKey === naturalKey
      ? currentJob.value
      : (naturalKey ? { site: site.emptyRef(naturalKey) } : null)

    currentJob.value = site.buildDomFallback(jd, base, site.readOutline())
  }

  /**
   * 收集诊断信息。
   *
   * 站点自己贡献选择器命中情况（site.diagnose）；通用部分（捕获记录、
   * 接口契约探针）在这里组装。
   *
   * 刻意抽成独立函数：把这段逻辑内联在 onMessage 回调里会让 TypeScript 在
   * 推导回调类型时退化（表现为 "This expression is not callable"）。
   */
  async function collectDiagnostic(): Promise<DiagnosticResult> {
    const job = currentJob.value
    const siteDiag = site.diagnose()

    const result: DiagnosticResult = {
      url: window.location.href,
      capturedApis: capturedApis.map(a => ({
        url: a.url,
        ok: a.ok,
        keys: a.keys,
        error: a.error,
      })),
      hasCurrentJob: job !== null,
      currentJobName: job?.job.title ?? null,
      currentJobSource: job?.source ?? null,
      jdLength: job?.jdText.length ?? 0,
      detailProbe: null,
      selectors: [],
    }

    // 详情接口探针：验证「标识 → JD」这条契约是否仍然成立
    const naturalKey = job?.site.naturalKey ?? ''
    if (naturalKey) {
      try {
        const probe = await site.probeDetail(naturalKey)
        result.detailProbe = {
          securityId: naturalKey,
          ok: true,
          hasPostDescription: probe.hasDescription,
          jdPreview: probe.preview,
        }
      }
      catch (error) {
        result.detailProbe = {
          securityId: naturalKey,
          ok: false,
          hasPostDescription: false,
          jdPreview: '',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    result.selectors = siteDiag.selectors.map((probe: { key: string, selector: string }) => {
      let count = 0
      try {
        count = document.querySelectorAll(probe.selector).length
      }
      catch {
        count = 0
      }
      return { key: probe.key, selector: probe.selector, found: count > 0, count }
    })

    const jd = site.readJd()
    if (jd) {
      result.selectors.push({
        key: '详情面板当前 JD',
        selector: '（已读取到文本）',
        found: true,
        count: jd.length,
      })
    }

    // DOM 兜底能读到的岗位标识：真机复验关键词选择器是否还有效
    result.domOutline = siteDiag.domOutline

    return result
  }

  // -------------------------------------------------------------------------
  // 注册
  // -------------------------------------------------------------------------

  const disposeInjectedListener = installInjectedListener()
  const disposeWatcher = watchJdChanges()

  onMessage('request-current-job', async ({ data }) => {
    await resolveCurrentJob(Boolean(data?.force))
    return { job: currentJob.value, url: window.location.href }
  })

  onMessage('run-diagnostic', async () => await collectDiagnostic())

  // eslint-disable-next-line no-console
  console.info(`[offer-hunter] 内容脚本已注入（${site.id}）`)

  /*
   * 返回拆卸函数。真实运行中内容脚本活到页面关闭、不需要拆卸，
   * 但**单测里反复创建会累积 window 监听器与定时器**，上一轮的实例会继续
   * 处理下一轮的快照消息，造成跨用例串扰。暴露出来才能写出干净的测试。
   */
  return () => {
    disposeInjectedListener()
    disposeWatcher()
  }
}
