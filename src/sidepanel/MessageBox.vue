<script setup lang="ts">
import type { MessageBoxKind } from './message-box'
import { MessageBox } from './message-box'

/**
 * 提示的渲染层：`fixed` 在面板底部，**完全不参与内容布局**。
 *
 * 关键约束：出现与消失都不能改变滚动区的高度。
 * 早先的版本给滚动容器垫过一块等高留白（为了「永不被遮」），代价是提示一多就冒出一条
 * 滚动条、一少又缩回去 —— 滚动条本身占宽度，内容会跟着左右抽动。这里宁可让提示浮在
 * 内容之上，也不去动布局：遮挡交给「时长短 + 可关闭 + 悬停暂停」来化解。
 */

/** 静态字符串，UnoCSS 能扫到；不要拼字符串生成类名，那样不会进产物 */
const KIND_CLASS: Record<MessageBoxKind, string> = {
  info: 'bg-gray-100/95 text-gray-700',
  success: 'bg-teal-50/95 text-teal-700',
  error: 'bg-red-50/95 text-red-700',
  loading: 'bg-teal-50/95 text-teal-700',
}

const KIND_ICON: Record<MessageBoxKind, string> = {
  info: 'i-tabler-info-circle',
  success: 'i-tabler-circle-check',
  error: 'i-tabler-alert-triangle',
  loading: 'i-tabler-loader-2 animate-spin',
}
</script>

<template>
  <div
    class="oh-msg-host pointer-events-none fixed inset-x-0 bottom-0 z-20 flex flex-col gap-1.5 p-2"
    role="status"
    aria-live="polite"
  >
    <!--
      上面这个 div 必须是组件的**唯一根节点**，模板里不要在它前面写注释：
      那样根会变成 fragment，$el 不再是宿主元素（单测里踩过）。

      宿主是 fixed 浮层：不参与布局、不改变滚动区高度，空的时候 pointer-events-none
      也不拦住面板底部的点击。role/aria-live 让屏幕阅读器能播报浮层里的提示。
    -->
    <TransitionGroup name="oh-msg">
      <div
        v-for="item in MessageBox.items"
        :key="item.id"
        class="oh-msg pointer-events-auto relative flex items-start gap-1.5 rounded-lg py-1.5 pl-2.5 pr-6 text-xs shadow-md"
        :class="[KIND_CLASS[item.kind], { 'oh-msg-paused': item.paused }]"
        @mouseenter="MessageBox.pause(item.id)"
        @mouseleave="MessageBox.resume(item.id)"
      >
        <span class="mt-[1px] shrink-0 text-sm" :class="KIND_ICON[item.kind]" />
        <span class="oh-msg-text min-w-0 flex-1">{{ item.text }}</span>

        <!-- 关闭按钮放右上角：多行文案时它不会把文字挤成窄条 -->
        <button
          class="oh-msg-close absolute right-0.5 top-0.5"
          title="关闭"
          aria-label="关闭提示"
          @click="MessageBox.dismiss(item.id)"
        >
          <span class="i-tabler-x text-xs" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.oh-msg {
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.oh-msg-paused {
  box-shadow: 0 0 0 1px rgba(13, 148, 136, 0.35), 0 4px 12px rgba(0, 0, 0, 0.12);
}

/*
  文案长度不可控（`res.error` 可能是整段 JSON），所以这里只管两件事：
  保住错误里的换行，以及让超长的不可断词（URL、base64）也能断开 —— 否则它会把
  提示条横向撑开、把旁边的关闭按钮挤走。

  刻意**不做滚动**（也不用 ScrollArea）：提示只有几行，滚动条在这么小的浮层里既难操作
  又和「一眼看完」的定位冲突；换行本来就能把内容装下。
*/
.oh-msg-text {
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

.oh-msg-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  border: none;
  border-radius: 0.25rem;
  background: transparent;
  color: currentColor;
  opacity: 0.55;
  cursor: pointer;
  transition: opacity 0.15s, background-color 0.15s;
}
.oh-msg-close:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.06);
}

.oh-msg-enter-active,
.oh-msg-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.oh-msg-enter-from,
.oh-msg-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
