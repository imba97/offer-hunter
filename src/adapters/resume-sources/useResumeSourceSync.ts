import type { ResumeContent, ResumeSourceAdapter } from '~/adapters/resume-sources/types'
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

  /**
   * 「这份内容是不是刚刚取过」。
   *
   * ⚠ 判据是**前缀**而不是完全相等，这是防回环的关键：适配器 `identify(config)` 算出的
   *   标识是「配置能确定的那部分」（例如 `<gistId>|`，因为文件名还没回写），而
   *   `fetch` 返回的 `contentKey` 带上了实际取到的子项（`<gistId>|resume.md`）。
   *   要求两者完全相等的话，自动挑文件那一次之后就会一直对不上 ——
   *   防回环与 10 分钟节流同时失效，同一份内容每次打开设置页都白取一次
   *   （烧 GitHub 匿名额度）。
   *
   * 前缀撞车的可能性可以忽略：Gist id 有 20+ 位十六进制，且后面紧跟 `|` 分隔符。
   */
  function sameContent(identifyKey: string, contentKey: string): boolean {
    return identifyKey.startsWith(contentKey) || contentKey.startsWith(identifyKey)
  }

  /** 与已记录的任一份内容相同（含前缀关系） */
  function anySameContent(identifyKey: string, keys: Set<string>): boolean {
    for (const key of keys) {
      if (sameContent(identifyKey, key))
        return true
    }
    return false
  }

  /**
   * 同步请求的序号，只允许最新一次的响应改写状态。
   *
   * ⚠ 必须有这个保护：`sync()` 没有重入限制（自动同步在途时用户再点一次「同步」、
   *   或在途时又改了配置），两个请求并发时**后返回的那个赢** —— 旧响应会把新内容
   *   覆盖掉，还会把 `lastSyncKey/lastSyncAt` 记成上一份，于是下一次又变成
   *   「同一份内容再取一次」。
   */
  let syncSeq = 0

  async function sync(): Promise<void> {
    const seq = ++syncSeq

    status.value = 'syncing'
    error.value = ''

    try {
      const res = await callBackground<
        { ok: true, content: ResumeContent } | { ok: false, error: string }
      >('resume-source:fetch', { sourceId: opts.adapter.id, config: opts.config() })

      // 期间又发起了新的同步：这次的响应已经过期，一个字段都不该写
      if (seq !== syncSeq)
        return

      if (!res.ok)
        throw new Error(res.error)

      const content = res.content

      /*
       * ⚠ 顺序要紧：**先判空 contentKey，再 onSynced**。
       *
       * 空 contentKey 是约定的信号「这个来源没有远端内容可取」（手动输入就是这样，
       * 见 paste/index.ts）。而 onSynced 的消费方会**无条件**写简历
       * （见 options/Options.vue 的 onSourceSynced）—— 先调它的话，一个返回空 key
       * 的远程来源会把用户简历清空并盖上新的同步时间。
       * 此前这里靠「只有 remote 来源才渲染面板」挡着，那是渲染层的巧合，不是契约。
       */
      if (!content.contentKey) {
        items.value = content.items ?? []
        status.value = 'idle'
        return
      }

      opts.onSynced(content)
      items.value = content.items ?? []

      message.value = `已同步 ${content.markdown.length} 字${content.label ? ` · ${content.label}` : ''}`
      status.value = 'ok'
      lastSyncKey = content.contentKey
      lastSyncAt = Date.now()
      syncedKeys.add(content.contentKey)
    }
    catch (err) {
      // 过期请求的失败同样不该覆盖新请求的状态
      if (seq !== syncSeq)
        return
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
    // 本会话里刚取回来的那份内容（它带着文件名，与上面的 key 只差后半段）
    if (anySameContent(key, syncedKeys))
      return

    /*
     * 用存下来的时间播种，但只在它确实属于当前这份内容时才算数。
     *
     * ⚠ 这里同样按前缀比：设置页重新打开时配置里的文件名可能还是空的（上一次自动挑中
     *   的文件名写在**简历**上、不一定回写进了来源配置），此时 identify 给的是
     *   `<id>|` 而存的 key 是 `<id>|resume.md` —— 完全相等的话这条节流永远不生效。
     */
    if (!lastSyncKey && opts.syncedKey() && sameContent(key, opts.syncedKey()!)) {
      const stored = Date.parse(opts.syncedAt() ?? '')
      if (Number.isFinite(stored)) {
        lastSyncKey = key
        lastSyncAt = stored
      }
    }

    if (lastSyncKey && sameContent(key, lastSyncKey) && Date.now() - lastSyncAt < AUTO_SYNC_MIN_INTERVAL_MS) {
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
