import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PromptField from '../PromptField.vue'

/**
 * 提示词输入框的行为测试。
 *
 * 设置页里两段提示词（打分口径、招呼语规则）共用这个组件，所以它一旦长歪就是
 * 两处一起歪。要紧的只有三件事：值能双向绑定、清空要二次确认、说明文字由调用方给。
 */

function mountField(modelValue = '') {
  return mount(PromptField, {
    props: { modelValue, title: '匹配度分析提示词', placeholder: '每行一条' },
    slots: { hint: '<strong>优先级高于默认</strong>；留空表示不加约束' },
  })
}

/** 看 emit 历史里有没有清空（值为 ''）那次 */
function hasClearEmitted(wrapper: ReturnType<typeof mountField>): boolean {
  return wrapper.emitted('update:modelValue')?.some(([v]) => v === '') ?? false
}

describe('promptField', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('渲染标题、占位符与调用方给的说明', () => {
    const wrapper = mountField()
    const textarea = wrapper.get('textarea')

    expect(wrapper.text()).toContain('匹配度分析提示词')
    expect(textarea.attributes('placeholder')).toBe('每行一条')
    expect(wrapper.get('p').text()).toContain('优先级高于默认')
  })

  it('输入把新值交回调用方（v-model）', async () => {
    const wrapper = mountField()
    await wrapper.get('textarea').setValue('更看重高并发经验')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['更看重高并发经验'])
  })

  it('值为空时不显示「清空」', () => {
    const wrapper = mountField()
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('第一次点「清空」不生效，按钮文字变成「确认清空？」', async () => {
    const wrapper = mountField('开头用您好')
    const button = wrapper.get('button')

    expect(button.text()).toBe('清空')
    await button.trigger('click')

    expect(hasClearEmitted(wrapper)).toBe(false)
    expect(wrapper.get('button').text()).toBe('确认清空？')
  })

  it('「待确认」期间再点一次才把值清成空串', async () => {
    const wrapper = mountField('开头用您好')
    const button = wrapper.get('button')

    await button.trigger('click')
    await button.trigger('click')

    expect(hasClearEmitted(wrapper)).toBe(true)
    // 清完后值为空串，按钮也跟着 v-if 消失
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('「待确认」状态 3 秒后自动撤销，再点要重新走两步', async () => {
    const wrapper = mountField('开头用您好')
    const button = wrapper.get('button')

    await button.trigger('click')
    expect(wrapper.get('button').text()).toBe('确认清空？')

    // 推进定时器后还要等 Vue 把 DOM 更新出来
    vi.advanceTimersByTime(3001)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('button').text()).toBe('清空')

    // 已经回到「清空」：这次点击只进入「待确认」，不会真的清
    await button.trigger('click')
    expect(hasClearEmitted(wrapper)).toBe(false)
  })

  it('「待确认」期间继续编辑输入框会撤销待确认', async () => {
    const wrapper = mountField('开头用您好')
    const button = wrapper.get('button')

    await button.trigger('click')
    expect(wrapper.get('button').text()).toBe('确认清空？')

    await wrapper.get('textarea').setValue('开头用您好，更突出开源经历')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('button').text()).toBe('清空')

    // 已经回到「清空」：此时再点只进入「待确认」，不会真的清
    await button.trigger('click')
    expect(hasClearEmitted(wrapper)).toBe(false)
  })
})
