<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as monaco from 'monaco-editor-core'
import { shikiToMonaco } from '@shikijs/monaco'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import vitesseDark from 'shiki/themes/vitesse-dark.mjs'
import markdown from 'shiki/langs/markdown.mjs'

/**
 * Markdown 编辑器：Monaco + Shiki 高亮。
 *
 * 按 Shiki 官方 Monaco 集成实现（https://shiki.style/packages/monaco）：
 *   monaco-editor-core + @shikijs/monaco 的 shikiToMonaco()
 *
 * 两个刻意的取舍：
 *
 * 1. 用「细粒度 bundle」（createHighlighterCore + 显式引入语法/主题），
 *    而不是 `shiki` 全量入口。全量入口会把所有语言和主题都打进产物。
 *
 * 2. 用 JavaScript 正则引擎而非 Oniguruma WASM：
 *    省掉 wasm 资源与 CSP 的麻烦，Markdown 这种简单语法完全够用。
 *
 * 3. 不注册任何 web worker：纯 Markdown 编辑不需要语言服务。
 *    Monaco 只在需要语言服务时才创建 worker（且用的是动态 URL），
 *    这里额外装上守卫，万一被触发也能给出明确报错而不是静默失败。
 */

const props = defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** Cmd/Ctrl + Enter */
  'submit': []
}>()

const host = ref<HTMLDivElement | null>(null)
const status = ref('正在加载编辑器…')
const failed = ref(false)

// Monaco 实例不需要深层响应式
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null)

async function initEditor(): Promise<void> {
  if (!host.value)
    return

  // 守卫：Markdown 不需要 worker，若被触发说明有意外，明确报错便于定位
  window.MonacoEnvironment = {
    getWorker() {
      throw new Error('[offer-hunter] Markdown 编辑器不应创建 web worker')
    },
  }

  status.value = '正在加载语法高亮…'

  const highlighter = await createHighlighterCore({
    themes: [vitesseDark],
    langs: [markdown],
    engine: createJavaScriptRegexEngine(),
  })

  // 注册语言 ID：只有注册过的语言才会被 Shiki 高亮
  monaco.languages.register({ id: 'markdown' })

  // 把 Shiki 的主题注册给 Monaco，并接上语法着色
  shikiToMonaco(highlighter, monaco)

  status.value = ''

  editor.value = monaco.editor.create(host.value, {
    value: props.modelValue,
    language: 'markdown',
    theme: 'vitesse-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 12.5,
    lineHeight: 20,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    renderLineHighlight: 'none',
    overviewRulerLanes: 0,
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    padding: { top: 10, bottom: 10 },
    tabSize: 2,
  })

  // 内容变化回传给父组件
  editor.value.onDidChangeModelContent(() => {
    const value = editor.value?.getValue() ?? ''
    if (value !== props.modelValue)
      emit('update:modelValue', value)
  })

  // Cmd/Ctrl + Enter 触发保存
  editor.value.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    emit('submit')
  })
}

onMounted(() => {
  initEditor().catch((error) => {
    failed.value = true
    status.value = `编辑器加载失败：${error instanceof Error ? error.message : String(error)}`
  })
})

// 外部（如导入 PDF / Gist）改动内容时同步进编辑器
watch(() => props.modelValue, (value) => {
  const current = editor.value?.getValue()
  if (editor.value && value !== current) {
    // pushEditOperations 保留撤销栈，比 setValue 体验好
    editor.value.pushUndoStop()
    editor.value.executeEdits('external', [{
      range: editor.value.getModel()!.getFullModelRange(),
      text: value,
    }])
    editor.value.pushUndoStop()
  }
})

onBeforeUnmount(() => {
  editor.value?.dispose()
  editor.value = null
})
</script>

<template>
  <div class="oh-editor-wrap">
    <div ref="host" class="oh-editor-host" />
    <div v-if="status" class="oh-editor-status" :class="{ 'oh-editor-status-error': failed }">
      {{ status }}
    </div>
  </div>
</template>

<style scoped>
.oh-editor-wrap {
  position: relative;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  overflow: hidden;
}
.oh-editor-host {
  height: 420px;
  width: 100%;
}
.oh-editor-status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ffffffe6;
  font-size: 0.8125rem;
  color: #6b7280;
  pointer-events: none;
}
.oh-editor-status-error {
  color: #dc2626;
}
</style>
