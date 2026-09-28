import type { ResumeContent, ResumeSourceAdapter } from '~/logic/resume-sources/types'
import { onBeforeUnmount, ref, watch } from 'vue'
import { callBackground } from '~/logic/messaging'

/**
 * 简历来源的「自动同步」编排。
 *
 * 从原来那个 Gist 专用组件里抽出来的**真正通用的那一半**：去抖、节流、内容标识比对、
 * 状态机、经后台取数。这些逻辑与「是 Gist 还是别的来源」毫无关系，此前却写在
 * Gist 专属组件里 —— 加第二个来源时必然要复制一整套（而复制出来的那份会慢慢
 * 和这份走偏）。
 *
 * 留在界面层的是**只有来源自己知道的东西**：有哪些配置字段、输入怎么收敛、
 * 子项怎么选。这些现在都由适配器声明（configFields / normalize / itemField），
 * 由 components/ResumeSourcePanel.vue 统一渲染 —— 普通来源因此不需要写任何组件。
 *
 * 三条不显眼的规则（都是从真机故障里总结的）：
 *
 * 1. **防抖**：用户可能来回改输入框，不值得每个中间态都发一次请求。
 * 2. **同一份内容 10 分钟内不重复取**：每次打开设置页都会触发自动同步，而
 *    GitHub 匿名额度只有每小时 60 次 —— 反复开关设置页就会白白烧完。
 *    这里用适配器给的 contentKey 判断「是不是同一份」。
 * 3. **节流的时间戳只在它确实属于当前这份内容时才算数**：换了 Gist 之后
 *    旧的 syncedAt 不该挡住新内容，否则看起来像坏掉了。
 */

/** 去抖：连续改配置只发一次请求 */
const AUTO_SYNC_DEBOUNCE_MS = 400

/**
 * 自动同步的最小间隔。
 *
 * 简历一天改一两次，而同一份内容反复取没有意义。手动点「同步」不受此限制。
 */
const AUTO_SYNC_MIN_INTERVAL_MS = 10 * 60 * 1000

export type SyncStatus = 'idle' | 'syncing' | 'ok' | 'fail' | 'skipped'

export interface UseResumeSourceSyncOptions {
  adapter: ResumeSourceAdapter
  /** 当前配置（响应式）。组件用 v-model 绑在来源配置对象上 */
  config: () => Record<string, unknown>
  /** 上一次同步成功的时间与内容标识（存在简历上，跨页面/跨设备可见） */
  syncedAt: () => string | null
  syncedKey: () => string | null
  /** 同步成功：内容与标识交给调用方写进简历 */
  onSynced: (content: ResumeContent) => void
}

export function useResumeSourceSync(opts: UseResumeSourceSyncOptions) {
  const status = ref<SyncStatus>('idle')
  const error = ref('')
  const message = ref('')
  /** 本次同步取到的可选子项（Gist 的文件名列表） */
  const items = ref<string[]>([])

  /** 本页面会话里已经同步过的内容标识，避免「同步 → 回写配置 → 再同步」成回环 */
  const syncedKeys = new Set<string>()

  /** 最近一次同步成功的内容标识与时间，供自动同步的间隔判断使用 */
  let lastSyncKey = ''
  let lastSyncAt = 0

  function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  async function sync(): Promise<void> {
    status.value = 'syncing'
    error.value = ''

    try {
      const res = await callBackground<
        { ok: true, content: ResumeContent } | { ok: false, error: string }
      >('resume-source:fetch', { sourceId: opts.adapter.id, config: opts.config() })

      if (!res.ok)
        throw new Error(res.error)

      const content = res.content
      opts.onSynced(content)
      items.value = content.items ?? []

      // 空内容视为「这个来源没有远端内容可取」（例如手动输入），不改状态也不写简历
      if (!content.contentKey) {
        status.value = 'idle'
        return
      }

      message.value = `已同步 ${content.markdown.length} 字${content.label ? ` · ${content.label}` : ''}`
      status.value = 'ok'
      lastSyncKey = content.contentKey
      lastSyncAt = Date.now()
      syncedKeys.add(content.contentKey)
    }
    catch (err) {
      status.value = 'fail'
      error.value = errorText(err)
    }
  }

  let autoSyncTimer: ReturnType<typeof setTimeout> | null = null

  function runAutoSync(): void {
    autoSyncTimer = null

    const key = opts.adapter.identify(opts.config())
    // 配置还不齐（用户可能正打到一半）—— 不报错，安静等着
    if (!key)
      return
    if (syncedKeys.has(key))
      return

    // 用存下来的时间播种，但只在它确实属于当前这份内容时才算数
    if (!lastSyncKey && opts.syncedKey() === key) {
      const stored = Date.parse(opts.syncedAt() ?? '')
      if (Number.isFinite(stored)) {
        lastSyncKey = key
        lastSyncAt = stored
      }
    }

    if (key === lastSyncKey && Date.now() - lastSyncAt < AUTO_SYNC_MIN_INTERVAL_MS) {
      status.value = 'skipped'
      return
    }

    void sync()
  }

  /*
   * 配置一变化就安排一次自动同步，写 immediate 让设置页每次打开都走到。
   * 比对的是**序列化后的配置**：来源的配置字段是各自定义的，这里不该认识它们，
   * 只能整体观察。
   */
  watch(
    () => JSON.stringify(opts.config()),
    () => {
      if (autoSyncTimer)
        clearTimeout(autoSyncTimer)
      autoSyncTimer = setTimeout(runAutoSync, AUTO_SYNC_DEBOUNCE_MS)
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    if (autoSyncTimer)
      clearTimeout(autoSyncTimer)
  })

  return { status, error, message, items, sync }
}
