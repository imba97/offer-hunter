/**
 * 简历来源适配器契约。
 *
 * 与 AI 平台那套（platform/ai）同构，但分两层而不是三层：
 *   protocol/platform/factory 三层是因为「wire 格式」与「平台预设」确实正交
 *   （OpenAI 协议被 DeepSeek / OpenAI / 自定义端点共用）。
 *   简历来源没有这种正交性 —— 每个来源自己的「取内容」方式就是它的全部，
 *   硬拆只会多一层没人读的间接。
 *
 * ⚠ 本文件与 registry.ts **不得引入任何运行时依赖**（尤其不能引 Vue 组件）：
 *   后台（service worker）要 import 注册表来路由消息，而组件一旦被拉进来，
 *   后台包会平白多出几 MB。自定义 UI 走 components/resume-sources 的查找表。
 */

/**
 * 简历来源标识。
 *
 * `'paste'` 是手动输入（没有远端可取，但走同一套接口 —— 见 paste.ts 的说明）。
 */
export type ResumeSourceId = 'paste' | 'gist'

/**
 * 配置字段类型。
 *
 * 只有设置页会用到，因此刻意保持极小：够描述「一个地址」「一个可选 token」即可。
 * 需要复杂交互（如从列表里挑文件）的来源走自定义 UI 组件，不在这里堆控件。
 */
export type ResumeConfigFieldType = 'text' | 'secret'

export interface ResumeConfigField {
  key: string
  type: ResumeConfigFieldType
  label: string
  placeholder?: string
  /** 字段下方的补充说明（可多行） */
  hint?: string
  /** 需要强调的风险提示，用琥珀色渲染 */
  warning?: string
  /** 留空是否算「配置齐全」。默认 true */
  optional?: boolean
}

/**
 * 一份内容的归一化结果 —— 所有来源取完后都必须收敛成这个形状。
 *
 * 关键字段是 `contentKey`：它取代了原先手工拼接的 `gistId|fileName`。
 * 适配器自己决定「什么算同一份内容」，上层只做字符串比较，不需要知道
 * 这个来源的身份是由几个字段拼出来的。
 */
export interface ResumeContent {
  /** Markdown 全文，喂给 AI 的主体 */
  markdown: string
  /**
   * 本来源内标识「这一份内容」的稳定字符串。
   *
   * 与 `Resume.syncedKey` 配合判断「现在这份是不是刚取过」。
   * 例：Gist 用 `<gistId>|<fileName>`（同一 Gist 换文件就是另一份内容）。
   */
  contentKey: string
  /** 人话描述取到了哪一份内容，用于界面回显，如「resume.md」 */
  label?: string
  /**
   * 这个来源里还可以选哪些子项（Gist 的文件名列表）。
   *
   * 存在的意义：Gist 这类来源必须先取一次才知道「有哪些文件」，
   * 因此选择项是**取完之后的补充输入**，没法静态写进 configFields。
   * 界面据此渲染「换一个文件」下拉；不提供的来源（如 PDF）留空即可。
   */
  items?: string[]
}

export interface ResumeSourceAdapter {
  id: ResumeSourceId
  /** 下拉框里的名字 */
  label: string
  /** 下拉框里的一句话说明 */
  hint: string

  /**
   * 空配置。切换到这个来源时就把它写进存储，保证表单永远有完整形状
   * （不这样做的话，新增来源时旧用户的配置对象里没有这个键，页面读到 undefined）。
   */
  createConfig: () => Record<string, unknown>

  /** 设置页据此渲染表单 */
  configFields: ResumeConfigField[]

  /**
   * 取内容。
   *
   * 在**后台**执行（出网请求只经过后台：SW 有 host_permissions 的跨源豁免，
   * 且凭据不下发到页面上下文）。
   *
   * `signal` 让「用户改了配置又立刻改回去」这类连续操作能取消上一次请求。
   */
  fetch: (
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ResumeContent>

  /**
   * 由配置算出「这次要取的是哪一份内容」，用于自动同步的防抖/节流判断。
   *
   * 返回空串表示配置还不齐，先不同步（不报错 —— 用户可能正打到一半）。
   *
   * 刻意与 `fetch` 的返回值分开：这个在**请求前**就要知道，用于判断
   * 「同一份内容 10 分钟内不重复取」；而 fetch 返回的 contentKey 是取完之后
   * 的权威值。
   *
   * ⚠ 两者的拼法必须一致（含子项选择）：fetch 之后界面往往会把「自动挑中的
   * 子项」回写进配置，配置一变就会再触发一次自动同步；若这里算出的 key 与刚
   * 记下的 contentKey 对不上，防回环就失效，会白发第二次请求。
   */
  identify: (config: Record<string, unknown>) => string
}
