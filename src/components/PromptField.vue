<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue'
import ScrollArea from '~/components/ScrollArea.vue'

/**
 * 一段自定义提示词的输入框。
 *
 * 设置页的「提示词」页里有好几段同构内容（打分口径、招呼语规则），抽出来是为了让
 * 它们**长得一模一样**：固定高度 + 自绘滚动条 + 右上角「清空」。各写一份的话，
 * 改高度或 padding 时总会漏掉其中一处（提示词框的 padding 就这么丢过一次）。
 *
 * 只负责「值 + 标题 + 占位符」，说明文字由调用方通过 hint 插槽给 —— 各字段要说的
 * 话并不相同（会拼进哪一轮提示词、优先级如何），写死在这里只会变成一堆 v-if。
 */

withDefaults(defineProps<{
  /** 字段名，显示在输入框上方 */
  title: string
  /** 空状态下的示例写法 */
  placeholder?: string
}>(), {
  placeholder: '',
})

const value = defineModel<string>({ required: true })

/**
 * 输入框的 id，给外层 `<label for>` 用。
 *
 * 这里有个**真实踩过的坑**：`<label>` 隐式关联的「labeled control」是它在 DOM
 * 树里遇到的**第一个** labelable 元素（button / input / textarea …），不是最近
 * 的、也不是人为指定的 —— 不显式 `for` 时，谁在前面它就绑谁。原先把整块（标题行
 * + ScrollArea）都包在 `<label>` 里，标题行里那个「清空」按钮刚好排在 textarea
 * 前面，结果点标题文字、甚至点空白区域，都会被浏览器当成「点击 label → 激活
 * 关联控件 → 给 button 派发一次 click」，于是 `clear()` 被无故触发。
 *
 * 用 `for` 显式指向 textarea，绕过这条隐式规则；`useId()` 保证同一页里多段提示词
 * 不会撞 id。
 */
const inputId = useId()

/**
 * 清空（带二次确认）。
 *
 * 「清空」一按就生效太容易误伤（手抖蹭到、误点），改成两步式：第一次按下进入
 * 「待确认」状态（按钮文字变红），3 秒内没二次按下就自动撤销；用户在这期间
 * 继续写内容也会撤销 —— 大概率改了主意。
 */
const confirming = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

function clearConfirmTimer(): void {
  if (confirmTimer !== null) {
    clearTimeout(confirmTimer)
    confirmTimer = null
  }
}

function startConfirm(): void {
  confirming.value = true
  clearConfirmTimer()
  confirmTimer = setTimeout(() => {
    confirming.value = false
    confirmTimer = null
  }, 3000)
}

function clear(): void {
  if (confirming.value) {
    value.value = ''
    clearConfirmTimer()
    confirming.value = false
    return
  }
  startConfirm()
}

// 用户在「待确认」期间继续编辑 → 撤销待确认；写下的内容说明他大概率不是想清空
watch(value, (v) => {
  if (confirming.value && v !== '') {
    clearConfirmTimer()
    confirming.value = false
  }
})

onBeforeUnmount(clearConfirmTimer)
</script>

<template>
  <div>
    <label :for="inputId" class="block">
      <span class="mb-1 flex items-center justify-between text-sm text-gray-600">
        <span>{{ title }}</span>
        <button
          v-if="value"
          type="button"
          class="text-xs transition-colors"
          :class="confirming
            ? 'text-red-600 hover:text-red-700'
            : 'text-gray-400 hover:text-gray-600'"
          @click="clear"
        >
          {{ confirming ? '确认清空？' : '清空' }}
        </button>
      </span>
      <!--
        提示词会长到十几行：固定高度 + 内部滚动，比让 textarea 自己撑高更可控。
        `resize-none` 是因为拖拽手柄与自绘滚动条会挤在同一个角上。
      -->
      <ScrollArea class="oh-prompt h-44" scroller-class="oh-prompt-pad">
        <textarea
          :id="inputId"
          v-model="value"
          class="oh-prompt-input font-mono text-xs leading-relaxed"
          :placeholder="placeholder"
        />
      </ScrollArea>
    </label>
    <p class="mt-1 text-xs text-gray-400">
      <slot name="hint" />
    </p>
  </div>
</template>

<style scoped>
.oh-prompt {
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  background: #fff;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.oh-prompt:focus-within {
  border-color: #0d9488;
  box-shadow: 0 0 0 2px rgba(13, 148, 136, 0.15);
}
/*
  ⚠ 内边距必须用 `:deep()` 打进去：`scrollerClass` 是给 ScrollArea **内部**那个滚动层加的，
  而它带的是 ScrollArea 自己的 scoped hash，本文件里普通的 `.oh-prompt-pad` 选择器
  （会编译成 `.oh-prompt-pad[data-v-本文件]`）永远匹配不上 —— 表现为 padding 直接消失。
  见 components/README.md 的「scrollerClass 的两条限制」。
*/
.oh-prompt :deep(.oh-prompt-pad) {
  padding: 0.4rem 0.6rem;
}
/*
  输入框自身**不滚动**：内容再长也让它长高，由外面的 ScrollArea 统一滚。
  否则会出现两个滚动条（textarea 的原生条 + 自绘条），而 textarea 那条没法套我们的样式。

  ⚠ 不要给 `max-height`：撞上它的那一刻就变成「内部裁掉、且连系统滚动条都没有」，
  用户写的后文会**静默消失**。高度上限交给外层 ScrollArea，这里只负责长高。
  `field-sizing: content` 是长高的首选；不支持它的浏览器由 `overflow-y: auto` 兜底，
  此时用的是系统滚动条，观感差一点但不会丢内容。
*/
.oh-prompt-input {
  field-sizing: content;
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 100%;
  overflow-y: auto;
  border: none;
  padding: 0;
  background: transparent;
  outline: none;
  resize: none;
}
</style>
