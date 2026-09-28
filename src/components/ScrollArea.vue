<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 滚动容器：**自绘滚动条**，替掉浏览器原生那一套。
 *
 * 为什么不用 `::-webkit-scrollbar`：
 *
 * 1. 想要的效果是「淡出 → 悬停容器渐显 → 再悬停到滚动条上更明显」，这三档
 *    依赖 `::-webkit-scrollbar-thumb:hover`。实测 Chromium **不会**把鼠标悬停投递给
 *    滚动条伪元素（连 `容器:hover::-webkit-scrollbar-thumb` 也不生效），纯 CSS 做不出来。
 * 2. 原生滚动条一旦常显就占宽度（经典滚动条 15px 上下），内容会跟着左右抽动；
 *    隐藏原生滚动条后宽度恒定，滚动条改为**浮在内容之上**。
 *
 * 因此：原生滚动条用 `scrollbar-width: none` / `::-webkit-scrollbar { width: 0; height: 0 }`
 * 彻底藏掉，滚动能力仍由原生滚动承担（滚轮、触控板、键盘、锚点、`scrollIntoView` 都不受影响），
 * 这里只额外画一根 `position: absolute` 的条，并让它跟着 `scrollTop` 走。
 *
 * 结构上有个容易踩的点：滚动条**必须**是滚动容器自己的绝对定位子元素。
 * 绝对定位元素相对「padding box」定位，而 padding box 不随内容滚动 ——
 * 所以它天然固定在可视区，不需要额外套一层 wrapper，也就不会多出一个盒子影响调用方的布局。
 *
 * 用法：
 * ```vue
 * <!-- 撑满父容器 -->
 * <ScrollArea class="min-h-0 flex-1">
 *   <div class="p-3">…</div>
 * </ScrollArea>
 *
 * <!-- 固定高度（需要给滚动条留出右内边距，否则会压住文字） -->
 * <ScrollArea class="max-h-64 pr-3">…</ScrollArea>
 * ```
 */

const props = withDefaults(defineProps<{
  /**
   * 滚动条的感应区宽度（px）。
   * 鼠标进入右侧这一条带就算「悬停到滚动条上」，因此也别取太宽：
   * 取 8–12 即可，再宽会把贴在右边缘的按钮（如提示条的关闭按钮）也算进去。
   */
  barWidth?: number
  /** 滑块最小高度（px）：内容再长也要留一个抓得住的目标 */
  thumbMinHeight?: number
  /** 给**内部滚动元素**追加的类名（padding、字体等应放这里，而不是根节点） */
  scrollerClass?: string | string[] | Record<string, boolean>
}>(), {
  barWidth: 10,
  thumbMinHeight: 32,
  scrollerClass: '',
})

/** 轨道相对可视区上下各内缩这么多 px，滑块高度与拖动换算都要用它 */
const TRACK_INSET = 2
/** 滚动条亮起后停留多久再淡出；比 CSS 的淡出（0.18s）长一点，避免闪烁 */
const REVEAL_HOLD_MS = 900

/** 悬停容器、悬停滚动条、正在拖动、刚刚滚过 —— 任一成立就显示滚动条 */
const hovering = ref(false)
const barHovering = ref(false)
const dragging = ref(false)
/** 键盘 / `scrollIntoView` 这类没有指针参与的滚动，也要让滚动条亮一下 */
const scrolling = ref(false)
/** 焦点在容器内（键盘 Tab 进来的用户看不到鼠标悬停） */
const focused = ref(false)

const scroller = ref<HTMLDivElement | null>(null)
const overflowing = ref(false)
const thumbHeight = ref(0)
const thumbOffset = ref(0)
/** 拖动时的抓取偏移：按下点相对滑块顶部的距离，避免一按就跳 */
const dragGrab = ref(0)
/**
 * 拖动时我们**自己**写下去的那个 `scrollTop`。
 *
 * 用它区分「用户滚动」与「拖动回写」：拖动写值会引发一次 scroll 事件，那次不该把
 * 滚动条点亮（会造成拖动过程中反复闪烁）。用「期望值」而不是一个布尔标记，是因为
 * 写值与 scroll 事件之间可能夹进一次真实滚动（滚轮/键盘），布尔标记会把那次吃掉。
 */
let expectedScrollTop: number | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let rafId = 0

/** 滑块位置用 px 直接算，不塞进模板表达式里做算术，读起来清楚些 */
const thumbStyle = computed(() => ({
  height: `${thumbHeight.value}px`,
  transform: `translateY(${thumbOffset.value}px)`,
}))

const active = computed(
  () => hovering.value || barHovering.value || dragging.value || focused.value || scrolling.value,
)

const trackStyle = computed(() => ({ width: `${props.barWidth}px` }))

/** 一次测量的结果：是否可滚、滑块多高、滑块在哪 */
function measure(): void {
  const el = scroller.value
  if (!el)
    return

  const { scrollHeight, clientHeight, scrollTop } = el
  // 留 1px 容差：某些缩放下 scrollHeight 会比 clientHeight 大 0.x
  const scrollable = scrollHeight - clientHeight > 1

  overflowing.value = scrollable
  if (!scrollable) {
    thumbHeight.value = 0
    thumbOffset.value = 0
    return
  }

  const trackHeight = Math.max(0, clientHeight - TRACK_INSET * 2)
  const height = Math.min(trackHeight, Math.max(props.thumbMinHeight, trackHeight * clientHeight / scrollHeight))
  const maxOffset = Math.max(0, trackHeight - height)
  const maxScroll = scrollHeight - clientHeight

  thumbHeight.value = height
  thumbOffset.value = maxScroll > 0 ? (scrollTop / maxScroll) * maxOffset : 0
}

/** 合并同一帧内的多次测量：ResizeObserver 回调可能一帧来好几条 */
function scheduleMeasure(): void {
  if (rafId)
    return
  // 测试环境（jsdom）没有 rAF，直接量一次即可，不值得为它再引一层 polyfill
  if (typeof requestAnimationFrame !== 'function') {
    measure()
    return
  }
  rafId = requestAnimationFrame(() => {
    rafId = 0
    measure()
  })
}

/**
 * 滚动。
 *
 * 滑块位置走 `scheduleMeasure` 合到一帧一次：滚动期间每个事件都同步读
 * `scrollHeight/clientHeight`（强制布局）并写三个 ref（触发渲染）是没必要的。
 * 但「亮起」必须每个事件都做 —— 它带 900ms 停留，靠的正是每次滚动都续期。
 */
function onScroll(): void {
  const el = scroller.value
  if (!el)
    return

  scheduleMeasure()

  // 这一次滚动是不是拖动自己写下去的？是就只更新滑块位置，不点亮。
  // 无论结论如何，期望值都只对**一条** scroll 事件有效，用完即清。
  const selfDriven = expectedScrollTop !== null
    && Math.abs(el.scrollTop - expectedScrollTop) <= 1
  expectedScrollTop = null
  if (selfDriven)
    return

  revealThenFade()
}

function revealThenFade(): void {
  scrolling.value = true
  if (idleTimer)
    clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    scrolling.value = false
  }, REVEAL_HOLD_MS)
}

/**
 * 指针是否落在右侧感应区内。
 *
 * 阈值取 `barWidth` 而不是更宽：滚动条是浮在内容上的，判定过宽会让「尾巴上的
 * 关闭按钮 / 图标」也被算成悬停滚动条，滑块提前变亮。
 */
function inBarZone(event: PointerEvent): boolean {
  const el = scroller.value
  if (!el)
    return false
  return event.clientX >= el.getBoundingClientRect().right - props.barWidth
}

function onPointerMove(event: PointerEvent): void {
  if (event.pointerType === 'touch')
    return
  hovering.value = true
  if (!dragging.value)
    barHovering.value = inBarZone(event)
}

function onPointerLeave(): void {
  hovering.value = false
  if (!dragging.value)
    barHovering.value = false
}

function onThumbPointerDown(event: PointerEvent): void {
  if (event.button !== 0)
    return
  const el = scroller.value
  if (!el)
    return

  event.preventDefault()
  dragging.value = true
  dragGrab.value = event.clientY - el.getBoundingClientRect().top - TRACK_INSET - thumbOffset.value
  // 指针捕获：拖出容器（甚至拖出窗口）也不会丢事件。
  // 个别环境（jsdom）没有这个 API，缺了也只是拖出容器时断流，不该因此抛错。
  const target = event.currentTarget as HTMLElement | null
  if (typeof target?.setPointerCapture === 'function')
    target.setPointerCapture(event.pointerId)
}

function onThumbPointerMove(event: PointerEvent): void {
  if (!dragging.value)
    return

  const el = scroller.value
  if (!el)
    return

  const trackHeight = Math.max(0, el.clientHeight - TRACK_INSET * 2)
  const maxOffset = Math.max(0, trackHeight - thumbHeight.value)
  if (maxOffset <= 0)
    return

  const top = event.clientY - el.getBoundingClientRect().top - TRACK_INSET - dragGrab.value
  const offset = Math.min(maxOffset, Math.max(0, top))
  const scrollTop = offset / maxOffset * (el.scrollHeight - el.clientHeight)

  // 先记下期望值再写：随后那条 scroll 事件靠它认出「是自己写的」
  expectedScrollTop = scrollTop
  el.scrollTop = scrollTop
}

function endDrag(): void {
  dragging.value = false
  // 松手后指针未必还在滚动条上，下一次 pointermove 会重新判定
  barHovering.value = false
}

function onPointerUp(): void {
  if (dragging.value)
    endDrag()
}

let observer: ResizeObserver | null = null
let mutationObserver: MutationObserver | null = null
let resizeHandler: (() => void) | null = null

onMounted(() => {
  measure()

  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(scheduleMeasure)
    if (scroller.value)
      observer.observe(scroller.value)
    // 内容块（默认插槽的第一层）一并观察：内容长高了但容器没变时也要重算滑块。
    // 用选择器而不是 `firstElementChild`，是为了不受模板里注释节点的影响。
    const content = scroller.value?.querySelector<HTMLElement>(':scope > *')
    if (content)
      observer.observe(content)
  }

  /*
    内容「长高」有时不经过 ResizeObserver：内容块若没有确定高度（`height: auto`），
    子元素变高不改变内容块自己的尺寸，观察它就收不到通知 —— 例如提示词输入框
    靠 `field-sizing: content` 随字符长高，却只改了文本节点。

    所以再挂一个 MutationObserver 兜这个缺口。回调走 `scheduleMeasure`，一帧最多量一次；
    这里不做任何 DOM 改写，不会和观察器互相触发。
  */
  if (scroller.value && typeof MutationObserver !== 'undefined') {
    mutationObserver = new MutationObserver(scheduleMeasure)
    mutationObserver.observe(scroller.value, { childList: true, subtree: true, characterData: true })
  }

  // 侧边栏会被用户拖着改宽，高度也会随窗口变；window 变化兜一次底
  resizeHandler = scheduleMeasure
  window.addEventListener('resize', resizeHandler)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  mutationObserver?.disconnect()
  mutationObserver = null
  if (resizeHandler)
    window.removeEventListener('resize', resizeHandler)
  resizeHandler = null
  if (idleTimer)
    clearTimeout(idleTimer)
  if (rafId && typeof cancelAnimationFrame === 'function')
    cancelAnimationFrame(rafId)
})

defineExpose({
  /** 内部滚动元素，需要 `scrollIntoView` / 读 `scrollTop` 时用 */
  scroller,
  /**
   * 手动重算一次滑块几何。
   *
   * 内容与尺寸变化已由 ResizeObserver + MutationObserver + scroll 覆盖，
   * 这里只留给「两种观察器都观察不到」的场景（以及单测直接驱动）。
   */
  measure,
})
</script>

<template>
  <div class="oh-scroll" @pointerenter="onPointerMove" @pointermove="onPointerMove" @pointerleave="onPointerLeave" @pointerup="onPointerUp" @pointercancel="onPointerUp">
    <div
      ref="scroller"
      class="oh-scroll-viewport"
      :class="scrollerClass"
      @scroll.passive="onScroll"
      @focusin="focused = true"
      @focusout="focused = false"
    >
      <slot />
    </div>

    <!--
      滚动条本体：装饰性元素，对读屏器与键盘用户没有意义（原生滚动仍在），故 aria-hidden。
      只在「可滚 + 滑块量得出来」时渲染，条数变化不会影响布局（绝对定位）。
    -->
    <div v-if="overflowing && thumbHeight > 0" class="oh-scroll-bar" :class="{ 'oh-scroll-bar-on': active }" :style="trackStyle" aria-hidden="true">
      <div
        class="oh-scroll-thumb"
        :class="{ 'oh-scroll-thumb-hot': barHovering, 'oh-scroll-thumb-drag': dragging }"
        :style="thumbStyle"
        @pointerdown="onThumbPointerDown"
        @pointermove="onThumbPointerMove"
      />
    </div>
  </div>
</template>

<style scoped>
/*
  根节点只负责「定位 + 尺寸」，不做滚动。
  内部滚动元素绝对定位铺满，等于把调用方给根节点的宽高原样让给它，
  于是 `<ScrollArea class="flex-1 min-h-0">` 这类写法与直接用 div 表现一致。
*/
.oh-scroll {
  position: relative;
}

.oh-scroll-viewport {
  position: absolute;
  inset: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: none;
  /* 藏掉原生滚动条：Firefox + Chromium 121+ */
  scrollbar-width: none;
}
/* 藏掉原生滚动条：旧 Chromium / WebKit */
.oh-scroll-viewport::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.oh-scroll-bar {
  position: absolute;
  top: 2px;
  bottom: 2px;
  right: 2px;
  z-index: 10;
  opacity: 0;
  transition: opacity 0.18s ease;
  /* 平时不拦事件，滚动条区域照样能把滚轮交给下面的内容；
     滑块单独打开 pointer-events 以便抓取。 */
  pointer-events: none;
  border-radius: 9999px;
}
/* 显示时轨道同时淡淡地透出来：滑块因此看起来是「落在一条槽里」，
   而不是凭空浮在内容上（透明度很低，不至于变成一道色带）。 */
.oh-scroll-bar-on {
  opacity: 1;
  background: rgba(17, 24, 39, 0.06);
}

.oh-scroll-thumb {
  position: absolute;
  top: 0;
  left: 50%;
  width: 6px;
  /* 半透明：静止时不该抢内容的注意力 */
  background: rgba(17, 24, 39, 0.3);
  border-radius: 9999px;
  transform-origin: top center;
  translate: -50% 0;
  transition: background-color 0.15s ease, width 0.15s ease;
  pointer-events: auto;
  touch-action: none;
  /* 与原生的「可拖拽」指针语义一致，不抢文本光标 */
  cursor: default;
}
/* 悬停到滚动条上：再明显一点（透明度降低）并稍微加宽 */
.oh-scroll-thumb-hot {
  width: 8px;
  background: rgba(17, 24, 39, 0.5);
}
/* 拖动中：最明显，且不该有过渡滞后 */
.oh-scroll-thumb-drag {
  width: 8px;
  background: rgba(17, 24, 39, 0.62);
  transition: none;
}
</style>
