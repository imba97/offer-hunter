import type { JobSiteAdapter } from './types'
import type { JobView } from '~/logic/types'

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
 *
 * ⚠ 这三条规则**互相耦合**：改动「什么时候读」会改变「读完那一刻面板上显示的是哪一版
 *   文本」，进而让规则 1 的比较前提失效。此前试过在此处加读取频率限制（把昂贵读推迟到
 *   DOM 安静之后），结果同时打破了规则 1 与规则 2 —— 详见那次回退的结论。要动这段逻辑，
 *   先想清「期望行为」，别只看局部。
 *
 * 抽成模块是为了让内容脚本只留「注册与编排」：这里的状态（签名、观察器、三个定时器）
 * 与它的三条规则自成一体，和「收注入消息 / 代发请求 / 诊断」没有关系。
 */

/** 兜底轮询间隔：观察器失联（SPA 换节点）或漏事件时把状态追回来 */
const JD_FALLBACK_POLL_MS = 5000
/** 详情容器还没渲染出来时的重试间隔 */
const JD_ATTACH_RETRY_MS = 500
/** 突变合并窗口：一次渲染会产生几十条记录，没必要每条都去读一遍文本 */
const JD_MUTATION_DEBOUNCE_MS = 120

export interface JdWatchOptions {
  site: JobSiteAdapter
  /** 读当前岗位（内容脚本持有那份 reactive 状态） */
  getJob: () => JobView | null
  /**
   * 写当前岗位。
   *
   * ⚠ 必须是「赋值给已有的 reactive 容器」而不是替换引用，否则侧边栏读到的还是旧值。
   */
  setJob: (job: JobView) => void
  /** 岗位真的变了 —— 由内容脚本负责推给后台 */
  onJobChanged: () => void
}

export function watchJdChanges(opts: JdWatchOptions): () => void {
  const { site, getJob, setJob, onJobChanged } = opts

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

    const existing = getJob()
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
      setJob(site.buildDomFallback(jd, existing, outline))
    }
    else {
      /*
       * 此前没有岗位，或是在 DOM 数据之间切换：重置身份，只带 URL 上的标识。
       * 地址上没有标识时，共用的兜底骨架会按岗位内容定一个本地身份并钉住它
       * （见 sites/dom-fallback.ts）—— 没有身份就没有账本键。
       */
      const naturalKey = site.naturalKeyFromUrl(window.location.href)
      setJob(site.buildDomFallback(
        jd,
        naturalKey ? { site: site.emptyRef(naturalKey) } : null,
        outline,
      ))
    }

    // eslint-disable-next-line no-console
    console.info('[offer-hunter] 从 DOM 回退更新了 JD')
    onJobChanged()
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
