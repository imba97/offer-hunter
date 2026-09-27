import type { DiagnosticResult, JobRecord, JobView } from '~/logic/types'
import { reactive } from 'vue'
import { onMessage, sendMessage } from 'webext-bridge/options'
import { isBossPageUrl } from '~/logic/boss/selectors'

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

/** 最近一条提示 */
export const notice = reactive<{ text: string, kind: 'info' | 'error' | 'success' }>({
  text: '',
  kind: 'info',
})

let noticeTimer: ReturnType<typeof setTimeout> | null = null

export function setNotice(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  notice.text = text
  notice.kind = kind
  if (noticeTimer)
    clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.text = ''
  }, 6000)
}

/** 当前标签页是否在 BOSS 页面（决定提示文案与操作可用性） */
export const pageState = reactive({ onBoss: false })

/** 当前窗口的活动标签 id（供 onUpdated 过滤用；其它标签的加载与我们无关） */
let activeTabId: number | null = null

/** 标签变化后的合并窗口：一次跳转 onUpdated 会连着触发好几次 */
const TAB_CHANGE_DEBOUNCE_MS = 250

/**
 * 只刷新「当前标签页是不是 BOSS」这一件事。
 *
 * 比 refreshCurrentJob 便宜得多（一次 tabs.query，不走后台转发），
 * 因此内容脚本推来岗位时也能顺手校正一次 —— 否则会出现「通知说切换了岗位，
 * 面板主体却还停在『当前标签页不是 BOSS 直聘』」这种自相矛盾的状态。
 */
export async function refreshPageState(): Promise<void> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    activeTabId = tab?.id ?? null
    pageState.onBoss = isBossPageUrl(tab?.url)
  }
  catch (error) {
    console.warn('[offer-hunter] 读取标签页失败', error)
    pageState.onBoss = false
  }
}

/**
 * 监听浏览器标签变化（切换标签 / 地址变化 / 加载完成），变化即回调。
 *
 * 不监听的话，面板只能靠 10s 兜底轮询发现，于是有两个明显延迟：
 *  1. 从别的页面新打开 BOSS 职位页 —— pageState 仍是「不在 BOSS」，
 *     岗位数据即使推过来了，面板主体也还显示着提示语
 *  2. 从 BOSS 切到别的标签 —— 上一个岗位的信息会赖在面板上不走
 *
 * 只关心**本侧边栏所在窗口**的活动标签；返回注销函数。
 */
export function listenForTabChanges(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let windowId: number | null = null

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
    // 记下新的活动标签，后续 onUpdated 才有得过滤
    activeTabId = info.tabId
    schedule()
  }

  const onUpdated = (tabId: number, changeInfo: { url?: string, status?: string }) => {
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
 * 订阅内容脚本推来的「岗位已变化」。
 *
 * 返回注销函数：侧边栏页面可能被反复打开，监听器要有明确的归属。
 */
export function listenForJobChanges(onChange: (job: JobView | null) => void): () => void {
  return onMessage('job-changed', ({ data }) => {
    onChange(data.job ?? null)
    return undefined
  })
}

/**
 * 从内容脚本拉取当前岗位。
 *
 * 侧边栏没有页面访问权，只能通过后台转发；同时刷新一次当前标签页状态，
 * 以便在非 BOSS 页面时给出明确提示。
 *
 * 这是**兜底**路径：正常情况下岗位变化由内容脚本主动推送（见 listenForJobChanges）。
 * `force = true` 时内容脚本会忽略自己的缓存重新取数 —— 面板上的「刷新当前岗位」用它，
 * 否则内存里是旧岗位/占位岗位时，面板没有任何纠正手段。
 */
export async function refreshCurrentJob(force = false): Promise<void> {
  // 先确定当前标签页是否在 BOSS 上
  await refreshPageState()

  // 再取岗位。注意：即使 onBoss 为 false 也照常尝试，
  // 因为用户可能把侧边栏停在一边、在另一个 BOSS 标签页里操作。
  try {
    const res = await sendMessage('relay-current-job', { force }, 'background')
    // 通信失败（内容脚本还没装载、页面正在跳转）时保留上一次的岗位，别把面板闪成空状态；
    // 「页面上确实没有岗位」由 ok=true + job=null 明确表达。
    if (res?.ok)
      currentJob.value = res.job ?? null
  }
  catch (error) {
    console.warn('[offer-hunter] 读取当前岗位失败', error)
  }
}

/** 从后台同步账本 */
export async function syncRecords(): Promise<void> {
  try {
    const all = await sendMessage('get-records', {}, 'background')
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
