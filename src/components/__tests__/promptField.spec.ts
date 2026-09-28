import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PromptField from '../PromptField.vue'

/**
 * 提示词输入框的行为测试。
 *
 * 设置页里两段提示词（打分口径、招呼语规则）共用这个组件，所以它一旦长歪就是
 * 两处一起歪。要紧的只有三件事：值能双向绑定、清空真的清空、说明文字由调用方给。
 */

function mountField(modelValue = '') {
  return mount(PromptField, {
    props: { modelValue, title: '匹配度分析提示词', placeholder: '每行一条' },
    slots: { hint: '<strong>优先级高于默认</strong>；留空表示不加约束' },
  })
}

describe('promptField', () => {
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

  it('有内容时才出现「清空」，点了会把值清成空串', async () => {
    const empty = mountField()
    expect(empty.find('button').exists()).toBe(false)

    const filled = mountField('开头用您好')
    const button = filled.get('button')
    expect(button.text()).toBe('清空')

    await button.trigger('click')
    expect(filled.emitted('update:modelValue')?.at(-1)).toEqual([''])
  })
})
