## Components

Components in this dir will be auto-registered and on-demand, powered by [unplugin-vue-components](https://github.com/unplugin/unplugin-vue-components).

Components can be shared in all views.

### Icons

You can use icons from almost any icon sets by the power of [Iconify](https://iconify.design/).

It will only bundle the icons you use. Check out [unplugin-icons](https://unplugin-icons.github.io/unplugin-icons/) for more details.

### ScrollArea

`ScrollArea.vue` —— 带自绘滚动条的滚动容器。**扩展里所有需要滚动的地方都用它**，
不要再用 `overflow-y-auto`，否则会同时出现两种滚动条。

```vue
<!-- 撑满父容器（侧边栏内容区那种） -->
<ScrollArea class="min-h-0 flex-1">
  <div class="p-3">…</div>
</ScrollArea>

<!-- 限高（JD 面板、提示条文本那种） -->
<ScrollArea class="max-h-64 px-3" scroller-class="py-2">
…
</ScrollArea>
```

| prop | 默认 | 说明 |
| --- | --- | --- |
| `barWidth` | `10` | 滚动条的感应/绘制宽度（px） |
| `thumbMinHeight` | `32` | 滑块最小高度（px），保证再长的内容也抓得住 |
| `scrollerClass` | `''` | 给**内部滚动元素**的类名；padding、字体这类该放这里 |

`class` 落在根节点上（管尺寸与定位），`scrollerClass` 落在真正滚动的那一层上。
右侧要给滚动条留出位置时，直接把 `px-*` 写在根节点上即可。

#### 必须给根节点一个高度

内部那一层可视区是**绝对定位**（这样滚动条才能钉在可视区上，见下面的说明），
绝对定位的元素不参与父级的高度计算 —— 所以根节点自己必须拿到一个确定的高度：

- ✅ 撑满父容器：`flex-1 min-h-0`（父级有确定高度时）或 `h-40`
- ✅ 限高：`max-h-64` / `h-screen`
- ✅ 兜底：`min-h-6`

```vue
<!-- 反例：flex 行里的 flex-1 会算出 0 高，文字被 0 高的可视区整段裁掉，只剩一条滚动条 -->
<div class="flex">
  <ScrollArea class="flex-1">…</ScrollArea>
</div>

<!-- 正例：给下限 -->
<div class="flex">
  <ScrollArea class="min-h-6 max-h-20 flex-1">…</ScrollArea>
</div>
```

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
- 滚动条是浮层，**会盖住最右侧 6px 的内容** —— 内容自己要有左右留白（现在的调用点都有）。
- `scrollerClass` 里不要给内部元素加 `padding-right` 之外的水平内边距去「让位」：
  留白应该加在根节点上，否则滚动条会跟着内容一起被推走。
- 排版依赖一个前提：绝对定位子元素相对 padding box 定位，而 padding box 不随内容滚动。
  所以滚动条天然固定在可视区，不需要再套一层 wrapper（套了反而要额外处理圆角与裁切）。
