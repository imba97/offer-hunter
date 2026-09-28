import { reactive } from 'vue'

/**
 * 侧边栏提示的统一入口（底部悬浮）。
 *
 * 为什么是「底部悬浮 + 调用式 API」：
 *  1. 原来的提示条挂在顶栏下方做绝对定位。位置在内容**顶部**，而顶部恰好是
 *     岗位名/薪资/匹配分这些最不该被遮的信息；文案又是 `res.error`、`match.summary`
 *     这类长度不可控的字符串，一条 AI 报错能盖住好几行。
 *  2. 提示**绝不参与布局**：`position: fixed` 浮在面板底部，出现与消失都不改变
 *     滚动区的高度，也就不会多出或少掉一条滚动条。
 *     曾经试过「给滚动区垫一块等高留白，换永不被遮」，结果是提示多一条滚动条就冒出来、
 *     少一条又缩回去 —— 滚动条本身占宽度，内容跟着左右抽动，比遮住底部更难用。
 *     所以遮挡改由交互化解：时长短、右上角可关、悬停暂停、最多三条。
 *  3. 调用点散落在匹配、招呼语、复制、诊断各处，逐个写一堆响应式状态太啰嗦，
 *     所以收敛成 `MessageBox.success('已复制')` 这种一次性调用。
 *
 * 用法：
 * ```ts
 * MessageBox.success('已复制到剪贴板')
 * MessageBox.error(res.error)
 * const id = MessageBox.loading('正在分析…')      // loading 默认不自动关闭
 * MessageBox.update(id, '分析完成', { kind: 'success' })
 * ```
 */

export type MessageBoxKind = 'info' | 'success' | 'error' | 'loading'

export interface MessageBoxOptions {
  kind?: MessageBoxKind
  /** 存活毫秒数；`0` 表示不自动关闭。缺省按 kind 取默认值 */
  duration?: number
  /**
   * 同 key 的消息视为**同一条**的更新（如「正在分析…」被后来的结果替换），
   * 替换而不是新叠一条，避免同一次操作留下两条提示。
   */
  key?: string
}

export interface MessageBoxItem {
  id: number
  text: string
  kind: MessageBoxKind
  key?: string
  /** 鼠标悬停时倒计时已暂停（提示条上有对应视觉反馈） */
  paused: boolean
}

/**
 * 默认存活时长。
 *
 * 比原来的 6s 短得多：底部提示不挡正文，久留没有必要；
 * 唯一需要多看两眼的是错误，标红 + 多留一会儿。
 */
const DEFAULT_DURATION: Record<MessageBoxKind, number> = {
  success: 2400,
  info: 2600,
  error: 4800,
  // 加载中的提示活多久取决于请求，不能由时长决定，只能由调用方 update/dismiss
  loading: 0,
}

/** 最多同时显示几条：底部空间有限，堆太多反而更挡内容 */
const MAX_VISIBLE = 3

const state = reactive({
  items: [] as MessageBoxItem[],
})

let nextId = 1

interface TimerState {
  handle: ReturnType<typeof setTimeout> | null
  /** 剩余时长：暂停时结算一次，恢复时接着走 */
  remaining: number
  startedAt: number
}

const timers = new Map<number, TimerState>()

function find(id: number): MessageBoxItem | undefined {
  return state.items.find(item => item.id === id)
}

function disarm(id: number): void {
  const timer = timers.get(id)
  if (!timer)
    return
  if (timer.handle)
    clearTimeout(timer.handle)
  timers.delete(id)
}

/** 关掉一条提示：定时器与列表里的条目一起清掉 */
function dismiss(id: number): void {
  disarm(id)
  const index = state.items.findIndex(item => item.id === id)
  if (index >= 0)
    state.items.splice(index, 1)
}

/** 重新开始计时；`ms <= 0` 表示常驻（loading / duration: 0） */
function arm(id: number, ms: number): void {
  disarm(id)
  const item = find(id)
  if (item)
    item.paused = false
  if (ms <= 0)
    return
  const timer: TimerState = { handle: null, remaining: ms, startedAt: Date.now() }
  timer.handle = setTimeout(dismiss, ms, id)
  timers.set(id, timer)
}

function push(text: string, options: MessageBoxOptions = {}): number {
  const kind = options.kind ?? 'info'
  const duration = options.duration ?? DEFAULT_DURATION[kind]
  const { key } = options

  if (key) {
    const existing = state.items.find(item => item.key === key)
    if (existing) {
      existing.text = text
      existing.kind = kind
      arm(existing.id, duration)
      return existing.id
    }
  }

  const item: MessageBoxItem = { id: nextId++, text, kind, key, paused: false }
  state.items.push(item)

  // 超出上限时挤掉最旧的（含正在倒计时的，所以它们的定时器要一起清掉）
  for (const stale of state.items.slice(0, Math.max(0, state.items.length - MAX_VISIBLE)))
    dismiss(stale.id)

  arm(item.id, duration)
  return item.id
}

function update(id: number, text: string, options: MessageBoxOptions = {}): void {
  const item = find(id)
  if (!item) {
    // 那条提示已经被用户关掉、或自动消失了。结果不能因此丢掉 —— 重新弹一条。
    push(text, options)
    return
  }
  item.text = text
  if (options.kind)
    item.kind = options.kind
  arm(id, options.duration ?? DEFAULT_DURATION[item.kind])
}

/** 悬停暂停：长文案（比如接口报错）不该读到一半就消失 */
function pause(id: number): void {
  const timer = timers.get(id)
  if (!timer)
    return
  if (timer.handle) {
    clearTimeout(timer.handle)
    timer.handle = null
    timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt))
  }
  const item = find(id)
  if (item)
    item.paused = true
}

function resume(id: number): void {
  const timer = timers.get(id)
  if (!timer || timer.handle)
    return
  // 悬停期间正好到点：remaining 归零，此时不能按「常驻」处理，直接关掉
  if (timer.remaining <= 0) {
    dismiss(id)
    return
  }
  arm(id, timer.remaining)
}

export const MessageBox = {
  /** 当前展示中的提示（渲染层用） */
  get items(): MessageBoxItem[] {
    return state.items
  },

  show: push,
  update,
  dismiss,
  pause,
  resume,

  info(text: string, options?: MessageBoxOptions): number {
    return push(text, { ...options, kind: 'info' })
  },
  success(text: string, options?: MessageBoxOptions): number {
    return push(text, { ...options, kind: 'success' })
  },
  error(text: string, options?: MessageBoxOptions): number {
    return push(text, { ...options, kind: 'error' })
  },
  /** 进行中的提示：默认常驻，直到被 `update` 或 `dismiss` */
  loading(text: string, options?: MessageBoxOptions): number {
    return push(text, { duration: 0, ...options, kind: 'loading' })
  },

  clear(): void {
    for (const item of [...state.items])
      dismiss(item.id)
  },
}
