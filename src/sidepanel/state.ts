import type { DiagnosticResult, JobRecord, JobView } from '~/logic/types'
import { reactive } from 'vue'
import { callBackground, onPageBroadcast } from '~/logic/messaging'
import { detectSite } from '~/sites/routing'

/**
 * 侧边栏的共享状态。
 *
 * 侧边栏是扩展页面，**不能直接读 BOSS 页面**，所有页面数据都要经由
 * 后台转发给内容脚本获取（见 background/main.ts 的 relay 部分）。
 */

/** 当前正在查看的岗位（含 JD），null 表示用户还没在页面上点开岗位 */
export const currentJob = reactive<{ value: JobView | null, url: string }>({
  value: null,
  url: '',
})

/** 账本（从后台读取） */
export const records = reactive<Record<string, JobRecord>>({})

/** 诊断结果 */
export const diagnostic = reactive<{ result: DiagnosticResult | null, running: boolean }>({
  result: null,
  running: false,
})

/**
 * 当前标签页是否在我们支持的招聘网站上（决定提示文案与操作可用性）。
 *
 * `checked` 区分「还没查过」与「查过且不是站点」：面板刚打开时查询还没回来，
 * 这时如果直接按 onSupportedSite=false 渲染，用户会先看到一瞬
 * 「当前标签页不是 X」的错误提示。有了这个标记，界面可以在这段极短的时间里
 * 显示中性的加载态。
 */
export const pageState = reactive({ onSupportedSite: false, checked: false })

/** 当前窗口的活动标签 id（供 onUpdated 过滤用；其它标签的加载与我们无关） */
let activeTabId: number | null = null

/** 标签变化后的合并窗口：一次跳转 onUpdated 会连着触发好几次 */
const TAB_CHANGE_DEBOUNCE_MS = 250

/**
 * 找到「面板该跟着看的那个标签页」。
 *
 * ⚠ 判据是**本窗口的活动标签**，刻意**不做全局回退**。
 *
 * 这里踩过一个坑：后台取岗位时曾经全局找任意一个站点标签页（别的窗口也算），
 * 于是用户从 BOSS 职位页切到别的页面后，面板仍然显示着那个岗位 ——
 * 因为后台从**另一个**残留的站点标签页把岗位取回来了。
 * 面板表达的是「你现在看的这个标签页上的岗位」，跟着别的标签页走是错的。
 *
 * 现在两边同源：这里挑出 tabId，随消息一起交给后台；
 * 后台不再自己去猜该问哪个标签页（它猜的口径与面板看到的必然有偏差）。
 *
 * 返回 null 表示当前标签页不是我们支持的招聘网站。
 */
async function findTargetTab(): Promise<{ tabId: number, siteId: string } | null> {
  try {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true })
    activeTabId = active?.id ?? null
    pageState.checked = true

    const site = detectSite(active?.url)
    if (active?.id !== undefined && site)
      return { tabId: active.id, siteId: site.id }
  }
  catch (error) {
    console.warn('[offer-hunter] 读取活动标签页失败', error)
    // 查不动也算「查过了」：总不能让界面永远停在加载态
    pageState.checked = true
  }

  return null
}

/**
 * 取「面板该跟着看的那个标签页」的 id；不是受支持站点时返回 null。
 *
 * 给诊断之类需要指定标签页的操作复用，保证与取岗位看的是同一个标签页。
 */
export async function currentSiteTabId(): Promise<number | null> {
  const target = await findTargetTab()
  pageState.onSupportedSite = target !== null
  return target?.tabId ?? null
}

/**
 * 刷新「面板该跟着看的标签页是不是受支持站点」。
 *
 * 判据与 refreshCurrentJob 完全同源（都走 findTargetTab），因此不会再出现
 * 「提示语说不在站点上、主体却显示着岗位」这种自相矛盾。
 *
 * 返回值就是刷新后的结果，省得调用方再读一次 pageState（少一次间接，
 * 也避免读到中间态）。
 */
export async function refreshPageState(): Promise<boolean> {
  const target = await findTargetTab()
  pageState.onSupportedSite = target !== null
  return pageState.onSupportedSite
}

/**
 * 监听浏览器标签变化（切换标签 / 地址变化 / 加载完成），变化即回调。
 *
 * 不监听的话，面板只能靠 10s 兜底轮询发现，于是有两个明显延迟：
 *  1. 从别的页面切到 BOSS 职位页 —— pageState 仍是「不在站点上」，
 *     岗位数据即使推过来了，面板主体也还显示着提示语
 *  2. 从 BOSS 切到别的标签 —— 上一个岗位的信息会赖在面板上不走
 *
 * ⚠ 只关心**本面板所在窗口**的活动标签。
 *   目标标签页的判据就是本窗口的活动标签（见 findTargetTab），
 *   别的窗口怎么切都与本面板无关 —— 不过滤的话，用户在别处每切一次标签
 *   都会让本面板白跑一趟「查标签页 + 转发内容脚本」。
 *
 * 返回注销函数。
 */
export function listenForTabChanges(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let windowId: number | null = null

  /*
   * 面板所在窗口的 id。异步取，未取到之前（windowId 仍为 null）不过滤，
   * 宁可多触发一次也不要漏掉变化。
   */
  browser.windows.getCurrent()
    .then((win) => { windowId = win.id ?? null })
    .catch(() => {})

  const schedule = () => {
    if (timer)
      clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, TAB_CHANGE_DEBOUNCE_MS)
  }

  const onActivated = (info: { tabId: number, windowId: number }) => {
    if (windowId !== null && info.windowId !== windowId)
      return
    // 记下新的活动标签，后续 onUpdated 才有得过滤（onUpdated 事件不带 windowId）
    activeTabId = info.tabId
    schedule()
  }

  const onUpdated = (tabId: number, changeInfo: { url?: string, status?: string }) => {
    // onUpdated 不带窗口信息，只能用活动标签 id 过滤掉无关标签的后台加载噪音
    if (activeTabId !== null && tabId !== activeTabId)
      return
    if (!changeInfo.url && changeInfo.status !== 'complete')
      return
    schedule()
  }

  browser.tabs.onActivated.addListener(onActivated)
  browser.tabs.onUpdated.addListener(onUpdated)

  return () => {
    browser.tabs.onActivated.removeListener(onActivated)
    browser.tabs.onUpdated.removeListener(onUpdated)
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}

/**
 * 订阅内容脚本推来的「岗位已变化」（内容脚本 → 后台 → 广播到各扩展页面）。
 *
 * 返回注销函数：侧边栏页面可能被反复打开，监听器要有明确的归属。
 */
export function listenForJobChanges(onChange: (job: JobView | null) => void): () => void {
  return onPageBroadcast<{ job: JobView | null }>('job-changed', ({ job }) => {
    onChange(job ?? null)
  })
}

/**
 * 从内容脚本拉取当前岗位。
 *
 * 侧边栏没有页面访问权，只能通过后台转发。
 *
 * 这是**兜底**路径：正常情况下岗位变化由内容脚本主动推送（见 listenForJobChanges）。
 * `force = true` 时内容脚本会忽略自己的缓存重新取数 —— 面板上的「刷新当前岗位」用它，
 * 否则内存里是旧岗位/占位岗位时，面板没有任何纠正手段。
 *
 * ⚠ 清空规则（曾经是 bug）：以前只在 `res.ok` 时赋值，于是**切到别的页面后
 *   上一个岗位会一直赖在面板上**。现在按三层判断：
 *     1. 当前标签页不是受支持站点 → 立刻清空岗位，且**不去够别的标签页**
 *     2. 是受支持站点且后台答 ok → 用返回的岗位（可能是 null，表示页面上没选岗位）
 *     3. 是受支持站点但后台通信失败（内容脚本未装载 / 页面跳转中）→ 保留旧值，
 *        否则面板会闪成空状态，而用户在页面上其实一切正常
 *
 * `tabId` 随消息一起发给后台：由面板决定问哪个标签页，避免后台自己猜
 * （它猜的口径与面板看到的会不一致，那正是「切走后岗位还在」的成因）。
 */
export async function refreshCurrentJob(force = false): Promise<void> {
  // 先按「本窗口活动标签」确定目标，顺带把 pageState 摆正
  const tabId = await currentSiteTabId()

  if (tabId === null) {
    // 当前标签页不是我们的站点：面板上没有岗位可显示
    currentJob.value = null
    return
  }

  try {
    const res = await callBackground<{ ok: boolean, job: JobView | null, reason?: string }>(
      'relay-current-job',
      { force, tabId },
    )
    if (res?.ok) {
      currentJob.value = res.job ?? null
      return
    }
    // 目标标签页确实存在，只是这一趟没通 —— 保留旧值比清空更合理
    console.warn('[offer-hunter] 读取当前岗位失败：', res?.reason ?? '未知原因')
  }
  catch (error) {
    console.warn('[offer-hunter] 读取当前岗位失败', error)
  }
}

/** 从后台同步账本 */
export async function syncRecords(): Promise<void> {
  try {
    const all = await callBackground<Record<string, JobRecord>>('get-records')
    if (all) {
      for (const key of Object.keys(records))
        delete records[key]
      Object.assign(records, all)
    }
  }
  catch (error) {
    console.warn('[offer-hunter] 读取账本失败', error)
  }
}
