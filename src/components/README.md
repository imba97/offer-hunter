## Components

Components in this dir will be auto-registered and on-demand, powered by [unplugin-vue-components](https://github.com/unplugin/unplugin-vue-components).

Components can be shared in all views.

### Icons

You can use icons from almost any icon sets by the power of [Iconify](https://iconify.design/).

It will only bundle the icons you use. Check out [unplugin-icons](https://unplugin-icons.github.io/unplugin-icons/) for more details.

### ScrollArea

`ScrollArea.vue` —— 带自绘滚动条的滚动容器。**扩展里自己写的滚动区都用它**，
不要再用 `overflow-y-auto`，否则会同时出现两种滚动条。

> 例外：**Monaco 编辑器**（`MarkdownEditor.vue`）用 Monaco 自己的滚动条 ——
> 那是它用 DOM + canvas 画的，还承担缩略图里的进度显示，套我们的样式只会两头不像。
> 它只有「主题色」和滑块宽度可以调，且**刻意保持默认**。

```vue
<!-- 撑满父容器（侧边栏内容区那种） -->
<ScrollArea class="min-h-0 flex-1">
  <div class="p-3">…</div>
</ScrollArea>

<!-- 限高（JD 面板那种）：上限 + 下限，留白加在滚动层上 -->
<ScrollArea class="max-h-64 min-h-40 border-t border-gray-100 oh-jd">
  <p>…</p>
</ScrollArea>

<style scoped>
.oh-jd :deep(.oh-scroll-viewport) { padding: 0.5rem 1rem 0.5rem 0.75rem; }
</style>
```

| prop | 默认 | 说明 |
| --- | --- | --- |
| `barWidth` | `10` | 滚动条的感应/绘制宽度（px） |
| `thumbMinHeight` | `32` | 滑块最小高度（px），保证再长的内容也抓得住 |
| `scrollerClass` | `''` | 给**内部滚动元素**的类名；padding、字体这类该放这里 |

`class` 落在根节点上（管尺寸与定位），`scrollerClass` 落在真正滚动的那一层上。
左右留白要加在**滚动层**上（见下），根节点上的 `px-*` 换不来让位空间。

#### `scrollerClass` 的两条限制

它加到的是 ScrollArea **内部**那一层，所以：

1. **只用全局样式**：UnoCSS 工具类（`px-6 py-10`、`py-2`）写在 `<style scoped>` 之外，
   全局生效，可以直接用。
2. **调用方 `<style scoped>` 里的类名会被静默忽略**：scoped 会编译成
   `.oh-xxx[data-v-调用方]`，而那一层带的是 ScrollArea 自己的 hash，选择器永远不匹配 ——
   表现是「样式像没写一样」（提示词输入框的 padding 就这么丢过一次）。
   要给它加样式，必须从调用方用 `:deep()` 打进去：

```vue
<ScrollArea class="oh-prompt h-44" scroller-class="oh-prompt-pad">

<style scoped>
.oh-prompt :deep(.oh-prompt-pad) { padding: 0.4rem 0.6rem; }
</style>
```

（ScrollArea 自己 `<style scoped>` 里定义的 `.oh-scroll-*` 不受影响，它就在同一个组件内。
真实的例子见 `PromptField.vue`，下面那段示例就是从它抄出来的。）

#### 必须给根节点一个高度

内部那一层可视区是**绝对定位**（这样滚动条才能钉在可视区上，见下面的说明），
绝对定位的元素不参与父级的高度计算 —— 所以根节点自己必须拿到一个**实际生效**的高度：

- ✅ 撑满父容器：`flex-1 min-h-0`（父级有确定高度时）或 `h-40`
- ✅ 限高：`max-h-64` **配合**一个下限（见下）
- ✅ 兜底：`min-h-6`

⚠ **只有 `max-h-*` 是不够的**：`max-height` 只封顶、不给高度，块盒又没有在流子元素，
根节点会塌成 1px（JD 面板就这么塌过：文字只剩半行、滑块几乎铺满轨道）。

```vue
<!-- 反例：只有上限 → 塌成 1px -->
<ScrollArea class="max-h-64" />

<!-- 正例：上限 + 下限 -->
<ScrollArea class="max-h-64 min-h-40" />

<!-- 反例：flex 行里的 flex-1 也会算出 0 高 -->
<div class="flex">
  <ScrollArea class="flex-1" />
</div>

<!-- 正例：给下限 -->
<div class="flex">
  <ScrollArea class="min-h-6 max-h-20 flex-1" />
</div>
```

（上面用自闭合写法只是为了示例简短；真实用法是 `<ScrollArea …>内容</ScrollArea>`。）

> 只有几行、不需要滚动的文案（例如底部提示条）**不要**套 ScrollArea ——
> 既拿不到确定高度，也会在小浮层里塞进一条难操作的滚动条。这类内容直接用
> `white-space: pre-wrap` + `overflow-wrap: break-word` 换行即可；
> 后者是为了让超长的不可断词（URL、base64）也能断开，不会把浮层横向撑开。

为什么不用 `::-webkit-scrollbar`：

1. 想要的是「静止隐形 → 悬停容器渐显 → 再悬停到滚动条上更明显」。第三条要靠
   `::-webkit-scrollbar-thumb:hover`，而实测 Chromium **不会**把鼠标悬停投递给滚动条伪元素
   （`容器:hover::-webkit-scrollbar-thumb` 同样不生效），纯 CSS 做不出来。
2. 原生滚动条一旦常显就占宽度，内容会随它出现/消失左右抽动；藏掉原生滚动条后宽度恒定，
   自绘的条改为浮在内容之上。

代价与注意点：

- 自绘的条只有 6px 视觉宽度，滑块本体是唯一可点的部分；轨道不响应点击（不做「点击翻页」）。
- 滚动条是浮层，**会盖住最右侧约 6px 的内容**：内容右侧必须留出 ≥12px 留白，
  而且**留白要加在滚动层上**（用 `:deep(.oh-scroll-viewport)`），加在根节点上没有用 ——
  内部那层实测会铺满根节点的 border box（见「必须给根节点一个高度」上面的说明）。
- 双击、键盘滚动等原生行为不受影响：滚动仍然由那一层的 `overflow: auto` 承担，
  自绘的只是「看起来的样子」。`scrollIntoView`、锚点跳转也都正常。

### PromptField

`PromptField.vue` —— 设置页里一段自定义提示词的输入框（标题 + 固定高度的多行框 +
右上角「清空」+ 说明插槽）。**设置页的提示词都用它**，不要再手写一份 ScrollArea +
textarea：各写一份的结果是高度、padding、清空按钮的行为各走各的（提示词框的
padding 就这么丢过一次，见上）。

| prop / 插槽 | 说明 |
| --- | --- |
| `v-model` | 提示词的文本内容（`required`） |
| `title` | 输入框上方的字段名 |
| `placeholder` | 空状态下的示例写法 |
| `#hint` | 框下方的说明文字；**各字段要说的不一样**（拼进哪一轮提示词、优先级如何），所以交给调用方 |

框高固定 `h-44`，内容超长由内部的 ScrollArea 滚；`textarea` 本身只负责长高（见上一节）。

### SecretInput

`SecretInput.vue` —— **所有密码框都用它**（Gist 链接/ID、Gist token、AI API Key）。
默认用 `type="password"` 遮住内容，右侧一个小眼睛（`i-tabler-eye` / `i-tabler-eye-off`）
切换明文，所以不要再手写 `<input type="password">`：那样没有「看一眼确认填对了」的路子。

```vue
<SecretInput v-model="ai.apiKey" class="font-mono" placeholder="sk-..." />
```

| prop / 事件 | 说明 |
| --- | --- |
| `v-model` | 输入值（`required`） |
| 其余属性（`placeholder`、`class`、`@blur`、`@keydown`…） | **透传到内层 `input`**，与直接写在一个 input 上等价 |

样式由组件自带（`.oh-secret-input`，与 `.oh-input` 同观感）。**不要传 `class="oh-input"`**：
调用方的 `.oh-input` 写在各自的 `<style scoped>` 里，匹配不到子组件内部的元素
（同上面 `scrollerClass` 的第 2 条限制），传了也不生效；要调字体就传全局工具类（如 `font-mono`）。

两个已踩过的坑，改这个组件时别踩回去：

1. `$attrs` 必须绑到内层 input（`inheritAttrs: false`）。绑在根 `div` 上时 `@blur` 会静默失效
   —— blur 不冒泡，而来源面板的「失焦才提交」正靠它。
2. 因此**不要**在组件里声明 `placeholder` 之类的 prop：声明了它就从 `$attrs` 里消失，
   而组件又没往 input 上绑，占位符会静默不见（这个是加组件时真实发生的）。
3. 眼睛上带 `@mousedown.prevent`：点它时不让焦点离开输入框，否则会先触发一次失焦提交。
4. 若某个面板里还有别的按钮，测试别再用 `wrapper.get('button')` 抓第一个按钮
   —— 它现在是小眼睛（`button.oh-secret-eye`）；同步按钮请用 `button.oh-btn-primary`。

### ResumeSourcePanel

`ResumeSourcePanel.vue` —— 简历来源的通用配置面板。**新增一个简历来源不需要写界面**：
输入框、说明、风险提示、「可选」徽标、子项下拉、同步按钮与状态条全部由适配器声明的
数据渲染（`configFields` / `normalize` / `itemField` / `itemLabel`）。

```vue
<ResumeSourcePanel
  :adapter="activeSource"
  :config="activeConfig"
  :synced-at="resume.syncedAt"
  :synced-key="resume.syncedKey"
  @update:config="updateSourceConfig"
  @synced="onSourceSynced"
/>
```

它只对 `contentSource === 'remote'` 的来源渲染（内容在本地的手动输入没有可同步的东西）。
两条容易踩的行为，改它之前先看一眼：

- **失焦/回车才提交**（不是边打边发请求）：输入框的值存在组件内部的 draft 里，
  与配置分开；正在编辑的字段会被标记为 dirty，**期间配置的回写不会冲掉它**。
- **改了主字段就清掉子项选择**：子项属于上一份内容，沿用会取错东西。
