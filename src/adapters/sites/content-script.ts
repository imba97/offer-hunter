import type { InjectedEntry } from './injected-protocol'
import type { JobSiteAdapter } from './types'
import { reactive } from 'vue'
import { onMessage, sendMessage } from 'webext-bridge/content-script'
import { collectDiagnostic } from './diagnostics'
import { asInjectedMessage, INJECTED_CHANNEL } from './injected-protocol'
import { watchJdChanges } from './jd-watch'
import { isApiSite } from './types'

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

export function createContentScript(site: JobSiteAdapter): () => void {
  /**
   * 有接口的站点（BOSS 这类）才走「捕获响应 + 主动补拉 + 接口探针」那几条路。
   *
   * 用三目而不是在每个调用点判 `isApiSite(site)`：narrowing 只在这里发生一次，
   * 下面所有用到接口方法的地方拿到的都是收窄后的类型，不必到处写非空断言。
   */
  const apiSite = isApiSite(site) ? site : null

  /** 当前正在查看的岗位（含 JD），null 表示用户还没点开任何岗位 */
  const currentJob = reactive<{ value: ReturnType<JobSiteAdapter['buildDomFallback']> | null }>({
    value: null,
  })

  /** 本会话捕获到的接口记录，用于诊断 */
  const capturedApis = reactive<InjectedEntry[]>([])

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
    if (!apiSite)
      return false

    const view = apiSite.viewFromApiPayload(payload, naturalKey)
    if (!view)
      return false

    const existing = currentJob.value
    /*
     * 判重交给站点：身份来源各家不同（多数站点看 naturalKey，BOSS 只能看 ids，
     * 因为它的 naturalKey 恒为空串）。此前这里写死「比 naturalKey」，于是 BOSS 上
     * 判重恒不成立 —— 同一份详情响应每次都被重新翻译、重建视图并广播一次。
     */
    if (existing?.source === 'api' && apiSite.sameApiView(existing, view))
      return false

    currentJob.value = view
    return true
  }

  function mergeCapturedEntries(entries: InjectedEntry[]): void {
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
    /*
     * DOM-only 站点（如电鸭社区）没有接口要捕获，manifest 也不会给它注入 MAIN
     * world 脚本 —— 挂监听等一条永远不会来的消息没有意义。
     */
    const api = apiSite
    if (!api)
      return () => {}

    const onMessageFromInjected = (ev: MessageEvent): void => {
      if (ev.source !== window)
        return

      // 通道与形状由 injected-protocol.ts 统一窄化（页面上别的脚本也在 postMessage）
      const msg = asInjectedMessage(ev.data)
      if (!msg)
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
        mergeCapturedEntries(msg.entries)

        const data = msg.lastDetail?.data
        if (data && !currentJob.value) {
          const naturalKey = msg.lastDetail?.url
            ? site.naturalKeyFromUrl(msg.lastDetail.url)
            : ''
          // 交给站点的接口翻译器自己解包信封（BOSS 是 payload.zpData）
          if (applyApiView(data, naturalKey))
            notifyJobChanged()
        }
        return
      }

      if (msg.type !== 'api')
        return

      const entry: InjectedEntry = {
        url: msg.url,
        ok: msg.ok,
        keys: msg.keys,
        error: msg.error,
      }
      mergeCapturedEntries([entry])

      if (msg.ok && api.isDetailApiUrl(msg.url) && msg.data) {
        const naturalKey = site.naturalKeyFromUrl(msg.url)
        if (applyApiView(msg.data, naturalKey)) {
          // eslint-disable-next-line no-console
          console.info(`[offer-hunter] 已更新当前岗位（${site.meta.id}）`)
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
   * 取数顺序：按标识主动补一次接口请求（仅 `source: 'api'` 的站点）→ DOM 兜底读 JD。
   * 冷却窗口只是为了不让「岗位已下架」这类失败被反复重发。
   *
   * ⚠ 读正文（BOSS 上要克隆节点并逐元素取计算样式，是本扩展最重的 DOM 操作）只在
   *   真的需要时才做：页面上有标识时，标识本身就回答了「是不是同一个岗位」。
   */
  const REFETCH_COOLDOWN_MS = 10_000

  async function resolveCurrentJob(force = false): Promise<void> {
    if (currentJob.value && !force)
      return

    const existing = currentJob.value
    const existingKey = existing?.site.naturalKey ?? ''
    const pageKey = site.naturalKeyFromUrl(window.location.href)

    /*
     * 只有「页面地址上没有标识、但手上已经有一个岗位」时才需要先读一次正文：
     * 那种情况下没有别的办法判断这是不是同一个岗位，而下面要靠它决定能不能沿用标识。
     */
    const probeJd = existing && !pageKey ? site.readJd() : null

    /*
     * 是不是同一个岗位：
     *  - 页面地址上有标识 → 和已有标识比一下就够了（不读正文）
     *  - 没有标识 → 问适配器（它认 URL，也认正文的包含关系）
     */
    const samePosting = existing !== null
      && (pageKey ? pageKey === existingKey : (probeJd !== null && site.sameJob(existing, probeJd)))

    /*
     * 地址上没有标识时沿用已有标识：刷新是「重新取数」而不是「换一个岗位」——
     * 丢掉标识会让这份岗位的接口数据（薪资、公司）与账本记录一起消失。
     */
    const naturalKey = pageKey || (samePosting ? existingKey : '')

    // 冷却窗口只在「同一个岗位 + 刚拉过」时起作用；强制刷新时忽略它
    const last = lastFetch
    const recentlyFetched = last !== null
      && last.key === naturalKey
      && Date.now() - last.at <= REFETCH_COOLDOWN_MS
    // DOM-only 站点没有可补拉的接口，直接走下面的 DOM 读取
    const shouldFetch = apiSite !== null && naturalKey.length > 0 && (!recentlyFetched || force)

    if (shouldFetch) {
      lastFetch = { key: naturalKey, at: Date.now() }
      try {
        const view = await apiSite.fetchView(naturalKey)
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
    const domJd = probeJd ?? site.readJd()
    if (!domJd || domJd === currentJob.value?.jdText)
      return

    /*
     * 已有接口数据、却认不出是同一个岗位，而地址上又没有标识可以证伪时：**保留接口数据**。
     *
     * 与观察器那条路（watchJdChanges 里的同一条规则）保持一致 —— 两条路对同一件事
     * 必须给出同一个答案，否则「刷新一下」就会把薪资/公司/招聘者抹掉、顺手把身份换掉，
     * 让刚分析过的结果变成孤儿。地址栏里没有 securityId 的 BOSS 岗位最容易撞上：
     * 页面正文与接口正文排版不同，包含关系判不出来。
     */
    if (existing && existing.source === 'api' && !samePosting && pageKey.length === 0) {
      // eslint-disable-next-line no-console
      console.info('[offer-hunter] 认不出是同一岗位且地址上没有标识，保留接口数据')
      return
    }

    /*
     * 同一个岗位就沿用已有数据（含接口给的薪资/公司/私有 id 与标识），
     * 否则重置身份 —— 认不出来时宁可只留 JD，也不能把上一个岗位的信息带过来。
     */
    const base = samePosting
      ? currentJob.value
      : (naturalKey ? { site: site.emptyRef(naturalKey) } : null)

    currentJob.value = site.buildDomFallback(domJd, base, site.readOutline())
  }

  // -------------------------------------------------------------------------
  // 注册
  // -------------------------------------------------------------------------

  const disposeInjectedListener = installInjectedListener()
  const disposeWatcher = watchJdChanges({
    site,
    getJob: () => currentJob.value,
    // ⚠ 赋值给已有的 reactive 容器，而不是换引用
    setJob: (job) => { currentJob.value = job },
    onJobChanged: notifyJobChanged,
  })

  onMessage('request-current-job', async ({ data }) => {
    await resolveCurrentJob(Boolean(data?.force))
    return { job: currentJob.value, url: window.location.href }
  })

  onMessage('run-diagnostic', async () => await collectDiagnostic({
    site,
    apiSite,
    job: currentJob.value,
    capturedApis,
  }))

  // eslint-disable-next-line no-console
  console.info(`[offer-hunter] 内容脚本已注入（${site.meta.id}）`)

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
