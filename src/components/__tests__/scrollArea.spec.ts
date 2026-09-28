import type { VueWrapper } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import ScrollArea from '../ScrollArea.vue'

/**
 * ScrollArea 的测试。
 *
 * jsdom 没有布局引擎，`scrollHeight` / `clientHeight` 一律是 0，所以这里用
 * `Object.defineProperty` 把它们设成可配置的假值，再断言滚动条的**行为**：
 * 什么时候出现、滑块多高、悬停到滚动条上会不会变明显、拖动有没有真的改 scrollTop。
 *
 * ⚠ 指针事件用 `dispatchEvent` 而不是 test-utils 的 `trigger()`：
 * jsdom 里 `MouseEvent.clientX` 是只读的，`trigger` 的第二个参数根本写不进去（会直接抛错）。
 *
 * 组件自己会用 rAF 合并测量（jsdom 没有 rAF，组件里已退化成同步测量），
 * 所以测量是同步的，等一个 tick 让 DOM 跟上即可。
 */

/** 假造一个可滚动元素：默认内容 2000px、可视 200px */
function fakeScrollMetrics(
  el: HTMLElement,
  { scrollHeight = 2000, clientHeight = 200, scrollTop }: { scrollHeight?: number, clientHeight?: number, scrollTop?: number } = {},
): void {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  // 用闭包存值而不是 `value:`：组件会真的写 scrollTop（拖动回写），
  // 只读假值会让「写进去的」和「读出来的」永远对不上，测不出真实行为。
  // 不传 scrollTop 时沿用当前值，方便「只改尺寸」的调用。
  let scroll = scrollTop ?? (el.scrollTop || 0)
  Object.defineProperty(el, 'scrollTop', {
    get: () => scroll,
    set: (next: number) => {
      scroll = next
    },
    configurable: true,
  })
  // 可视区 0..200，右侧边界 300，与组件里 2px 内缩的轨道对齐
  el.getBoundingClientRect = () => ({ top: 0, right: 300, bottom: 200, left: 0 }) as DOMRect
}

async function mountArea(
  options: { scrollHeight?: number, clientHeight?: number, scrollTop?: number } = {},
) {
  const wrapper = mount(ScrollArea, {
    attachTo: document.body,
    props: { scrollerClass: 'oh-test-viewport' },
    slots: { default: '<p>内容</p>' },
  })
  const viewport = wrapper.find('.oh-test-viewport').element as HTMLElement
  fakeScrollMetrics(viewport, options)
  // 首次测量发生在 mounted（那时还是 0），改完假值后手动触发一次
  exposed(wrapper).measure()
  await nextTick()
  return { wrapper, viewport }
}

/**
 * `defineExpose` 暴露出来的接口。
 *
 * ⚠ 必须显式标注：项目里 `*.vue` 走 `declare module '*.vue'`（默认导出 `any`），
 * 而挂载结果的类型是「props + emit」，读不到 exposed 属性，编译期会报
 * "Property 'measure' does not exist"。
 */
interface ScrollAreaApi {
  scroller: HTMLElement | null
  measure: () => void
}

function exposed(wrapper: VueWrapper): ScrollAreaApi {
  return wrapper.vm as unknown as ScrollAreaApi
}

/** 派发指针事件：`clientX` / `clientY` 只能在构造时给 */
function pointer(el: Element, type: string, init: PointerEventInit = {}): void {
  const event = typeof PointerEvent === 'function'
    ? new PointerEvent(type, { bubbles: true, ...init })
    : new MouseEvent(type, { bubbles: true, clientX: init.clientX, clientY: init.clientY })
  el.dispatchEvent(event)
}

type Mounted = Awaited<ReturnType<typeof mountArea>>

function thumbStyle(wrapper: Mounted['wrapper']): { height: number, offset: number } {
  const style = (wrapper.find('.oh-scroll-thumb').element as HTMLElement).style
  return {
    height: Number.parseFloat(style.height),
    offset: Number.parseFloat(style.transform.replace(/[^\d.-]/g, '')),
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('scrollArea', () => {
  it('内容超出容器才出现滚动条', async () => {
    const { wrapper } = await mountArea({ scrollHeight: 2000, clientHeight: 200 })
    expect(wrapper.find('.oh-scroll-bar').exists()).toBe(true)
  })

  it('内容没超出时不渲染滚动条（不占位、不干扰）', async () => {
    const { wrapper } = await mountArea({ scrollHeight: 200, clientHeight: 200 })
    expect(wrapper.find('.oh-scroll-bar').exists()).toBe(false)
    expect(wrapper.find('.oh-scroll-thumb').exists()).toBe(false)
  })

  it('滑块高度按可视区/内容比例，并兜住最小可抓取高度', async () => {
    // 200 / 2000 * (200 - 4) = 19.6px，低于最小 32px → 取 32px
    const { wrapper } = await mountArea({ scrollHeight: 2000, clientHeight: 200 })
    expect(thumbStyle(wrapper).height).toBe(32)
  })

  it('内容不长时滑块按比例变高，不会永远贴着最小值', async () => {
    // 200 / 500 * 196 = 78.4px
    const { wrapper } = await mountArea({ scrollHeight: 500, clientHeight: 200 })
    expect(thumbStyle(wrapper).height).toBeCloseTo(78.4, 1)
  })

  it('静止时滚动条是隐形的（显隐由 class 控制）', async () => {
    const { wrapper } = await mountArea()
    expect(wrapper.find('.oh-scroll-bar').classes()).not.toContain('oh-scroll-bar-on')
  })

  it('hover 到容器后渐显', async () => {
    const { wrapper } = await mountArea()
    pointer(wrapper.find('.oh-scroll').element, 'pointerenter', { clientX: 100, clientY: 60 })
    await nextTick()
    expect(wrapper.find('.oh-scroll-bar').classes()).toContain('oh-scroll-bar-on')
  })

  it('hover 到滚动条区域时滑块变明显，移回内容区就恢复', async () => {
    const { wrapper } = await mountArea()
    const root = wrapper.find('.oh-scroll').element

    pointer(root, 'pointerenter', { clientX: 295, clientY: 60 })
    // 容器右边缘 300，感应区宽 10px
    pointer(root, 'pointermove', { clientX: 295, clientY: 60 })
    await nextTick()
    expect(wrapper.find('.oh-scroll-thumb').classes()).toContain('oh-scroll-thumb-hot')

    pointer(root, 'pointermove', { clientX: 100, clientY: 60 })
    await nextTick()
    expect(wrapper.find('.oh-scroll-thumb').classes()).not.toContain('oh-scroll-thumb-hot')
  })

  it('移出容器后滚动条重新隐藏（拖动中除外）', async () => {
    const { wrapper } = await mountArea()
    const root = wrapper.find('.oh-scroll').element

    pointer(root, 'pointerenter', { clientX: 100, clientY: 60 })
    pointer(root, 'pointerleave')
    await nextTick()
    expect(wrapper.find('.oh-scroll-bar').classes()).not.toContain('oh-scroll-bar-on')
  })

  it('键盘滚动（不经过鼠标）也会让滚动条亮一下', async () => {
    const { wrapper } = await mountArea()
    pointer(wrapper.find('.oh-test-viewport').element, 'scroll')
    await nextTick()
    expect(wrapper.find('.oh-scroll-bar').classes()).toContain('oh-scroll-bar-on')
  })

  it('拖动滑块真的会滚动内容', async () => {
    const { wrapper, viewport } = await mountArea({ scrollTop: 0 })
    const thumb = wrapper.find('.oh-scroll-thumb').element

    pointer(thumb, 'pointerdown', { button: 0, clientY: 5, pointerId: 1 })
    await nextTick()
    expect(wrapper.find('.oh-scroll-thumb').classes()).toContain('oh-scroll-thumb-drag')

    // 抓取点距滑块顶部 5px，拖到 y=100 → 滑块顶部落在 100-2-5=93px
    pointer(thumb, 'pointermove', { clientY: 100, pointerId: 1 })
    expect(viewport.scrollTop).toBeGreaterThan(0)

    pointer(thumb, 'pointerup', { pointerId: 1 })
    await nextTick()
    expect(wrapper.find('.oh-scroll-thumb').classes()).not.toContain('oh-scroll-thumb-drag')
  })

  it('拖动自己写下的 scrollTop 只更新滑块，不点亮滚动条', async () => {
    const { wrapper, viewport } = await mountArea({ scrollTop: 0 })
    const root = wrapper.find('.oh-scroll').element
    const thumb = wrapper.find('.oh-scroll-thumb').element
    const bar = () => wrapper.find('.oh-scroll-bar').classes()

    // 指针停在内容区（不在感应区），拖动前只有 hover 撑着它显示
    pointer(root, 'pointerenter', { clientX: 100, clientY: 60 })
    pointer(thumb, 'pointerdown', { button: 0, clientY: 2, pointerId: 1 })
    pointer(thumb, 'pointermove', { clientY: 60, pointerId: 1 })

    const draggedTo = viewport.scrollTop
    expect(draggedTo).toBeGreaterThan(0)

    // 指针移出容器 + 松手，此后没有任何理由让条亮着
    pointer(root, 'pointerleave')
    pointer(root, 'pointerup', { pointerId: 1 })
    await nextTick()

    // 拖动回写引发的那条 scroll：scrollTop 与期望值一致 → 不算用户滚动
    pointer(viewport, 'scroll')
    await nextTick()
    expect(bar()).not.toContain('oh-scroll-bar-on')

    // 之后用户自己滚（scrollTop 变了）→ 必须点亮
    fakeScrollMetrics(viewport, { scrollTop: draggedTo + 200 })
    pointer(viewport, 'scroll')
    await nextTick()
    expect(bar()).toContain('oh-scroll-bar-on')
  })

  it('滚动位置换成滑块偏移，且不会超出轨道', async () => {
    const { wrapper, viewport } = await mountArea({ scrollTop: 900 })
    // 轨道 196px、滑块 32px → 可移动 164px；滚到 1800 的一半 → 82px
    expect(thumbStyle(wrapper).offset).toBeCloseTo(82, 1)

    // 滚到底（jsdom 会钳住真实 layout，所以直接改假值）
    fakeScrollMetrics(viewport, { scrollTop: 1800 })
    exposed(wrapper).measure()
    await nextTick()
    expect(thumbStyle(wrapper).offset).toBeCloseTo(164, 1)
  })

  it('拖动过程中滚动条保持显示，松手后按指针位置决定去留', async () => {
    const { wrapper, viewport } = await mountArea({ scrollTop: 0 })
    const root = wrapper.find('.oh-scroll').element
    const thumb = wrapper.find('.oh-scroll-thumb').element
    const bar = () => wrapper.find('.oh-scroll-bar').classes()

    // 指针停在内容区（不在滚动条感应区里），此时只有 hover 撑着它显示
    pointer(root, 'pointerenter', { clientX: 100, clientY: 60 })
    pointer(thumb, 'pointerdown', { button: 0, clientY: 2, pointerId: 1 })
    pointer(thumb, 'pointermove', { clientY: 60, pointerId: 1 })
    expect(viewport.scrollTop).toBeGreaterThan(0)

    // 拖动中即使指针移出容器也不能消失，否则拖到一半条就没了
    pointer(root, 'pointerleave')
    await nextTick()
    expect(bar()).toContain('oh-scroll-bar-on')

    // 松手：指针确实不在容器上，回到隐形
    pointer(root, 'pointerup', { pointerId: 1 })
    await nextTick()
    expect(bar()).not.toContain('oh-scroll-bar-on')
  })

  it('暴露给外部的 scroller 指向内部滚动元素', async () => {
    const { wrapper, viewport } = await mountArea()
    // defineExpose 的是 ref，公共实例代理会自动解包，故这里显式标类型
    expect(exposed(wrapper).scroller as unknown as HTMLElement).toBe(viewport)
  })

  it('卸载后不再监听 window resize', async () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { wrapper } = await mountArea()
    wrapper.unmount()
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function))
    remove.mockRestore()
  })
})
