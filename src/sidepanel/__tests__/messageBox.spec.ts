import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBox } from '../message-box'
import MessageBoxHost from '../MessageBox.vue'

/**
 * 提示器的测试。
 *
 * 这一支的行为都是「时间相关」的，所以全程用假定时器：
 * 自动关闭、暂停/恢复、以及「update 复用同一条」都要能精确断言到毫秒。
 *
 * ⚠ MessageBox 是模块级单例，用例之间必须清空，否则上一条的定时器会漏到下一条。
 */

describe('messageBox', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MessageBox.clear()
  })

  afterEach(() => {
    MessageBox.clear()
    vi.useRealTimers()
  })

  it('success 到期自动消失，不需要调用方管', () => {
    MessageBox.success('已复制到剪贴板')
    expect(MessageBox.items).toHaveLength(1)

    vi.advanceTimersByTime(2_400)
    expect(MessageBox.items).toHaveLength(0)
  })

  it('loading 常驻，只能由 update 或 dismiss 结束', () => {
    const id = MessageBox.loading('正在分析…')

    // 分析耗时可能远超任何「合理」的提示时长，不能到点自己消失
    vi.advanceTimersByTime(60_000)
    expect(MessageBox.items).toHaveLength(1)

    MessageBox.dismiss(id)
    expect(MessageBox.items).toHaveLength(0)
  })

  it('update 复用同一条提示，并按新状态重新计时', () => {
    const id = MessageBox.loading('正在分析「前端工程师」…')
    vi.advanceTimersByTime(8_000)

    MessageBox.update(id, '匹配度 82（阈值 75）', { kind: 'success' })

    expect(MessageBox.items).toHaveLength(1)
    expect(MessageBox.items[0]?.id).toBe(id)
    expect(MessageBox.items[0]?.kind).toBe('success')

    // 重新按 success 的默认时长计时，而不是沿用 loading 的「永不关闭」
    vi.advanceTimersByTime(2_399)
    expect(MessageBox.items).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(MessageBox.items).toHaveLength(0)
  })

  it('提示已被用户关掉时，update 不会把结果吞掉', () => {
    const id = MessageBox.loading('正在生成招呼语…')
    MessageBox.dismiss(id)

    MessageBox.update(id, '生成失败：连接超时', { kind: 'error' })

    expect(MessageBox.items).toHaveLength(1)
    expect(MessageBox.items[0]?.text).toBe('生成失败：连接超时')
    expect(MessageBox.items[0]?.kind).toBe('error')
  })

  it('同 key 的消息替换而不是叠加', () => {
    MessageBox.loading('步骤 1', { key: 'job-switch' })
    MessageBox.success('步骤 2', { key: 'job-switch' })

    expect(MessageBox.items).toHaveLength(1)
    expect(MessageBox.items[0]?.text).toBe('步骤 2')
  })

  it('最多同时显示三条，挤掉的是最旧的', () => {
    const first = MessageBox.loading('1')
    MessageBox.loading('2')
    MessageBox.loading('3')
    MessageBox.loading('4')

    expect(MessageBox.items).toHaveLength(3)
    expect(MessageBox.items.map(item => item.id)).not.toContain(first)
  })

  it('悬停暂停后不消失，移开后按剩余时间消失', () => {
    const id = MessageBox.info('这条有点长，得看完')
    vi.advanceTimersByTime(1_000)

    MessageBox.pause(id)
    vi.advanceTimersByTime(60_000)
    expect(MessageBox.items).toHaveLength(1)
    expect(MessageBox.items[0]?.paused).toBe(true)

    MessageBox.resume(id)
    expect(MessageBox.items[0]?.paused).toBe(false)

    // 剩余 1600ms：先差 1ms，正好到点
    vi.advanceTimersByTime(1_599)
    expect(MessageBox.items).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(MessageBox.items).toHaveLength(0)
  })

  it('不再暴露任何会影响布局的高度接口', () => {
    // 回归护栏：早先给滚动区垫过等高留白，提示一多就冒出滚动条、一少又缩回去，
    // 滚动条占宽导致内容左右抖。提示必须与布局彻底解耦，别再把这个口子开回来。
    const api = MessageBox as unknown as Record<string, unknown>
    expect(api.reservedHeight).toBeUndefined()
    expect(api.setReservedHeight).toBeUndefined()
  })
})

describe('messageBoxHost', () => {
  beforeEach(() => {
    MessageBox.clear()
  })

  afterEach(() => {
    MessageBox.clear()
  })

  it('宿主是脱离文档流的浮层，不会撑开内容高度', () => {
    const wrapper = mount(MessageBoxHost)
    const host = wrapper.element as HTMLElement

    // fixed + bottom-0 = 不参与布局；有了它，提示条无论几条都不改变滚动区高度
    expect(host.className).toContain('fixed')
    expect(host.className).toContain('bottom-0')
    // 宿主内部不能出现任何占位元素（留白方案回归的信号）
    expect(host.querySelector('[style*="height"]')).toBeNull()

    wrapper.unmount()
  })

  it('右上角关闭按钮只关掉它那一条', async () => {
    MessageBox.error('出错了')
    const second = MessageBox.info('另一条')

    const wrapper = mount(MessageBoxHost)
    expect(wrapper.findAll('.oh-msg')).toHaveLength(2)

    await wrapper.find('.oh-msg-close').trigger('click')

    expect(MessageBox.items).toHaveLength(1)
    expect(MessageBox.items[0]?.id).toBe(second)

    wrapper.unmount()
  })
})
