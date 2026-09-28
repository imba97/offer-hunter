import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import SecretInput from '../SecretInput.vue'

/**
 * 密码框 + 小眼睛。
 *
 * 要紧的只有三件事：
 *  - 默认必须是密文（漏成明文就等于把凭据摆在设置页上）
 *  - 眼睛真的能来回切，图标/读屏名字跟着变
 *  - 写在这个组件上的属性与监听器要落在**内层 input** 上（来源面板的
 *    「失焦才提交」全靠 `@blur` 透传；落在根 div 上会静默失效，因为 blur 不冒泡）
 */

function mountInput(attrs: Record<string, unknown> = {}, modelValue = '') {
  return mount(SecretInput, { props: { modelValue }, attrs })
}

describe('secretInput', () => {
  it('默认遮住内容，眼睛提示「显示内容」', () => {
    const wrapper = mountInput({}, 'ghp_secret')

    const input = wrapper.get('input')
    const eye = wrapper.get('button')

    expect(input.attributes('type')).toBe('password')
    expect(eye.attributes('aria-label')).toBe('显示内容')
    expect(eye.find('span').classes()).toContain('i-tabler-eye')
  })

  it('点眼睛切明文，再点回密文', async () => {
    const wrapper = mountInput({}, 'ghp_secret')
    const input = wrapper.get('input')
    const eye = wrapper.get('button')

    await eye.trigger('click')

    expect(input.attributes('type')).toBe('text')
    expect(eye.attributes('aria-label')).toBe('隐藏内容')
    expect(eye.find('span').classes()).toContain('i-tabler-eye-off')

    await eye.trigger('click')

    expect(input.attributes('type')).toBe('password')
    expect(eye.find('span').classes()).toContain('i-tabler-eye')
  })

  it('明文状态下照常 v-model', async () => {
    const wrapper = mountInput({}, '')
    const input = wrapper.get('input')

    await wrapper.get('button').trigger('click')
    await input.setValue('sk-1')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['sk-1'])
  })

  it('属性与监听器落在内层 input 上，不落在根节点', async () => {
    const onBlur = vi.fn()
    const wrapper = mountInput({ placeholder: 'ghp_…', class: 'font-mono', onBlur })

    const input = wrapper.get('input')
    expect(input.attributes('placeholder')).toBe('ghp_…')
    expect(input.classes()).toContain('font-mono')
    // 自带的那份 .oh-input 等价样式不能被调用方的 class 顶掉
    expect(input.classes()).toContain('oh-secret-input')
    expect(wrapper.classes()).not.toContain('font-mono')

    await input.trigger('blur')
    expect(onBlur).toHaveBeenCalledTimes(1)
  })

  it('点眼睛不会让焦点离开输入框', () => {
    const wrapper = mountInput()
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })

    wrapper.get('button').element.dispatchEvent(event)

    // 不 prevent 的话，来源面板里会先触发一次失焦提交，用户得点第二下才切到明文
    expect(event.defaultPrevented).toBe(true)
  })
})
