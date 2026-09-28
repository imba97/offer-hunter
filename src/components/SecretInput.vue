<script setup lang="ts">
import { ref } from 'vue'

// 关掉默认透传：不关的话属性会**同时**落到根 div 与内层 input 上（根 div 上那份是脏的）
defineOptions({ inheritAttrs: false })

/**
 * 密码输入框：默认遮住内容，右侧一个小眼睛切换明文 / 密文。
 *
 * 抽出来的原因：设置页有 3 个这种框（Gist 链接、Gist token、AI API Key），
 * 各写一份的话，「眼睛的位置、明文时图标、遮住时图标」总要漏掉一两处。
 *
 * 为什么自己带一份 `.oh-input` 的样式，而不是让调用方传 `class="oh-input"`：
 * 调用方（Options.vue / GistPicker.vue）的 `.oh-input` 写在各自的 `<style scoped>` 里，
 * 只作用于**它自己模板里的元素** —— 落到子组件内部的 input 上时选择器永远不匹配
 * （同 components/README.md 里 `scrollerClass` 的第 2 条限制）。所以样式必须由本组件持有。
 *
 * 透传：`inheritAttrs: false` + 把 `$attrs` 绑到**内层 input**（而不是根节点的 div）。
 * 这样调用方写在这个组件上的 `@blur` / `@keydown` / `placeholder` / `class="font-mono"`
 * 与直接写在一个 input 上完全等价 —— 尤其 `@blur`：它不冒泡，若落在根 div 上，
 * GistPicker 的「失焦才提交」会静默失效。`v-bind="$attrs"` 放在静态属性之后，
 * 调用方给的 autocomplete 之类可以覆盖这里的默认值。
 *
 * ⚠ 因此**不要**在这里声明 `placeholder` 之类的 prop：声明了它就会被抽成 prop、
 * 不再出现在 `$attrs` 里，而这里又没往 input 上绑 —— 占位符会静默消失。
 */

const value = defineModel<string>({ required: true })

/** 是否明文显示。默认遮住 —— 这几个字段本来就是「看一眼少一眼」的凭据类内容 */
const revealed = ref(false)
</script>

<template>
  <div class="oh-secret">
    <input
      v-model="value"
      :type="revealed ? 'text' : 'password'"
      class="oh-secret-input"
      autocomplete="off"
      spellcheck="false"
      v-bind="$attrs"
    >
    <!--
      `mousedown.prevent`：点眼睛时不让焦点从输入框跑掉。否则在 GistPicker 里
      会先触发失焦提交（可能弹一条「认不出」的提示），回来再点第二次才轮到眼睛。
      键盘 Tab 仍能聚焦到这个按钮（aria-label 也给了读屏一个名字）。
    -->
    <button
      type="button"
      class="oh-secret-eye"
      :aria-label="revealed ? '隐藏内容' : '显示内容'"
      :title="revealed ? '隐藏内容' : '显示内容'"
      @mousedown.prevent
      @click="revealed = !revealed"
    >
      <span :class="revealed ? 'i-tabler-eye-off' : 'i-tabler-eye'" class="text-base" />
    </button>
  </div>
</template>

<style scoped>
.oh-secret {
  position: relative;
  width: 100%;
}
.oh-secret-input {
  width: 100%;
  /* 右侧多留一格给眼睛，免得长文案钻到图标底下 */
  padding: 0.4rem 2rem 0.4rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  background: #fff;
  color: inherit;
  font-size: 0.875rem;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.oh-secret-input:focus {
  border-color: #0d9488;
  box-shadow: 0 0 0 2px rgba(13, 148, 136, 0.15);
}
.oh-secret-eye {
  position: absolute;
  top: 50%;
  right: 0.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  transform: translateY(-50%);
  border: none;
  border-radius: 0.25rem;
  background: transparent;
  color: #9ca3af;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.oh-secret-eye:hover {
  background: #f3f4f6;
  color: #4b5563;
}
/* 键盘走到这里时要看得见焦点（鼠标点不会留框，靠 :focus-visible 区分） */
.oh-secret-eye:focus-visible {
  outline: 2px solid rgba(13, 148, 136, 0.5);
  outline-offset: 1px;
  color: #4b5563;
}
</style>
