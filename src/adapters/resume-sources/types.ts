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
 *   后台包会平白多出几 MB。来源界面由 components/ResumeSourcePanel.vue 按
 *   **configFields 这份纯数据**渲染，因此也不需要在契约里挂组件。
 */

/**
 * 简历来源标识。
 *
 * 与 `SiteId` 一样是**开放字符串**：来源是按目录约定自动索引的
 * （`logic/resume-sources/<id>/index.ts`，见 registry.ts），因此领域模型不能是
 * 闭合联合 —— 那会逼着「加一个来源还要改这里」，正是这次重构要消掉的耦合。
 * 代价是拼错 id 编译器不再拦，改由测试兜底（见 __tests__/resumeSources.spec.ts）。
 */
export type ResumeSourceId = string
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
  /**
   * 标成「可选」：字段名旁边挂一个灰色徽标。
   *
   * 只影响渲染，不参与校验 —— 这个扩展从不因为字段缺失而拦住用户，
   * 配置不齐时的行为由来源自己的 `identify`（返回空串表示「先不同步」）决定。
   */
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
  /** 人话描述取到了哪一份内容，**只用于界面回显**，如「简历.md（已自动挑选）」 */
  label?: string
  /**
   * 这次取到的**子项值**，会被写回配置里的 `itemField`（Gist 是文件名）。
   *
   * ⚠ 与 `label` 分开是必须的：`label` 是给人看的文案（可以带装饰、可以重复），
   *   而回写进配置的值必须是**能与 `items` 里的选项对上的那个键**。
   *   此前两者共用 `label` —— 换个来源只要把 label 写成展示文案，就会被静默写进
   *   配置（下拉框里选不中任何一项），而契约上完全看不出这个约束。
   *
   * 留空表示这次没有需要回写的子项（例如配置里已经指定了，或这个来源没有子项）。
   */
  item?: string
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

  /**
   * 设置页的表单声明 —— **来源界面的唯一出处**。
   *
   * 通用面板（components/ResumeSourcePanel.vue）按它渲染输入框、说明与「可选」标记，
   * 因此一份普通配置（几个文本框）**不需要写任何组件**。
   * 需要复杂交互（从列表里挑一项、可视化预览…）的来源才另写组件并挂进
   * Options.vue 的查找表，那时也仍然可以只覆盖其中一部分。
   *
   * ⚠ 不要在这里写「取完之后才知道」的东西（如 Gist 的文件名）：那些属于
   *   items（见 ResumeContent.items）与 itemField。
   */
  configFields: ResumeConfigField[]

  /**
   * 内容在哪一边 —— 设置页据此决定「要不要显示来源面板」与「编辑器能不能改」。
   *
   *  - `'local'`：内容就在本地（手动输入）。编辑器可写，没有可同步的东西，
   *    因此来源面板整块不渲染（否则会给「手动编辑」配一个没有意义的同步按钮）。
   *  - `'remote'`：内容以远端为准。编辑器只读 —— 否则用户会改出一份既不是远端、
   *    也不会被同步覆盖的幻觉内容；来源面板显示取数配置与同步按钮。
   *
   * 与站点层的 `source` 同一个用意：用一个显式判别替代散落各处的 `id === 'gist'`。
   */
  contentSource: 'local' | 'remote'

  /**
   * 用户输入收敛：把输入框里的文本变成**要存进配置的值**。
   *
   * 通用面板在输入框失焦/回车时调用它，让「人怎么写」与「系统怎么存」解耦：
   * Gist 的链接、带 `#file-xxx` 的分享链接都会被收敛成裸 ID。
   *
   * 返回 `null` 表示这次输入认不出来 —— 面板会还原输入框并就地报错，
   * **不改配置**（悄悄把用户填好的值清掉比留着旧值更糟）。
   * 不实现这个方法表示输入原样存储。
   *
   * 刻意只管「一个字段 → 一个值」：跨字段的联动（例如换了取数目标就丢掉上一份的
   * 子项选择）由通用面板按 `itemField` 统一处理，不需要每个来源自己记得。
   */
  normalize?: (field: string, value: string) => string | null

  /**
   * 「取完之后再选一项」写回哪个配置键（Gist 是 `fileName`）。
   *
   * 与 `ResumeContent.items` 配对：那里给出可选项，这里说选中项存到哪。
   * 留空表示这个来源没有子项可选。
   */
  itemField?: string
  /** 子项下拉的标题；留空时面板用通用文案 */
  itemLabel?: string

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

/**
 * 声明一个简历来源适配器。
 *
 * 与站点那套的 `defineSite()` 同形，只是这里没有可省的字段（来源之间的差异都是
 * 行为，不是配置）。存在的主要意义有两个：
 *
 *  1. **统一写法**：每个来源目录的 `index.ts` 都写成
 *     `export default defineResumeSource({ … })`，注册表据此按目录约定 glob 它们。
 *  2. **id 与目录名一致这条约定有个可读的落点**：id 由适配器自己声明，测试比对
 *     它与目录名（见 __tests__/resumeSources.spec.ts），而不是靠记性。
 */
export function defineResumeSource(adapter: ResumeSourceAdapter): ResumeSourceAdapter {
  return adapter
}
