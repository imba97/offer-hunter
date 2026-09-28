<script setup lang="ts">
import type { AiPlatformName, AiSettings, MatchingSettings, Resume } from '~/logic/types'
import { computed, defineAsyncComponent, defineComponent, h, ref } from 'vue'
import logo from '~/assets/logo.png'
import ScrollArea from '~/components/ScrollArea.vue'
import { callBackground } from '~/logic/messaging'
import { resetAllStorage, STORAGE_KEYS, useStoredValue } from '~/logic/storage'
import {
  createDefaultAiSettings,
  createDefaultMatchingSettings,
  createEmptyResume,
} from '~/logic/types'
import { AI_PLATFORM_OPTIONS } from '~/platform/ai/platforms'

/**
 * 设置页：简历维护 + 打招呼规则 + AI 平台配置。
 *
 * 独立标签页打开，空间充足（侧边栏太窄，放不下编辑器与完整表单）。
 * PDF / GitHub Gist 简历导入尚未实现（见 README 的「当前进度」）。
 *
 * 存储统一走 logic/storage 的 useStoredValue，保证与 service worker 侧
 * 读写格式一致（模板自带的 composable 会把值序列化成字符串，导致后台读不到）。
 */

/**
 * 编辑器懒加载。
 *
 * MarkdownEditor 背后是 monaco-editor-core + shiki，单独就有 4 MB 上下；
 * 静态 import 会让「只想改一下 API Key」也先下载解析这 4 MB（首屏 ≈4.3 MB）。
 * 改成异步组件后首屏只剩应用本身（≈0.1 MB），编辑器分块在挂载时并行加载。
 */
const EditorLoading = defineComponent({
  render: () => h('div', { class: 'oh-editor-loading' }, '正在加载编辑器…'),
})

const MarkdownEditor = defineAsyncComponent({
  loader: () => import('~/components/MarkdownEditor.vue'),
  loadingComponent: EditorLoading,
  delay: 0,
})

const ai = useStoredValue<AiSettings>(STORAGE_KEYS.ai, createDefaultAiSettings)
const resume = useStoredValue<Resume>(STORAGE_KEYS.resume, createEmptyResume)

const tab = ref<'resume' | 'greeting' | 'ai'>('resume')

const matching = useStoredValue<MatchingSettings>(
  STORAGE_KEYS.matching,
  createDefaultMatchingSettings,
)

const platformHint = computed(
  () => AI_PLATFORM_OPTIONS.find(o => o.value === ai.value.platform)?.hint ?? '',
)

function setPlatform(value: AiPlatformName) {
  ai.value.platform = value
  // 切换平台时清空自定义覆盖，回到该平台默认
  ai.value.baseUrl = ''
  ai.value.model = ''
}

// ---------------------------------------------------------------------------
// 连通性测试
// ---------------------------------------------------------------------------

type TestState
  = | { status: 'idle' }
    | { status: 'testing' }
    | { status: 'ok', provider: string, model: string, reply: string, latencyMs: number }
    | { status: 'fail', error: string, provider?: string, model?: string }

const test = ref<TestState>({ status: 'idle' })

async function runTest() {
  test.value = { status: 'testing' }
  try {
    const res = await callBackground<{
      ok: boolean
      provider?: string
      model?: string
      reply?: string
      latencyMs?: number
      error?: string
    }>('ai-test')
    if (res.ok) {
      test.value = {
        status: 'ok',
        provider: res.provider ?? '',
        model: res.model ?? '',
        reply: res.reply ?? '',
        latencyMs: res.latencyMs ?? 0,
      }
    }
    else {
      test.value = {
        status: 'fail',
        error: res.error ?? '未知错误',
        provider: res.provider,
        model: res.model,
      }
    }
  }
  catch (error) {
    test.value = {
      status: 'fail',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function touchResume() {
  resume.value.updatedAt = new Date().toISOString()
}

// ---------------------------------------------------------------------------
// 数据管理
// ---------------------------------------------------------------------------

/**
 * 清空扩展数据。
 *
 * 之前 storage 里留了 resetAllStorage 但没有任何入口 —— 简历、API Key、岗位账本
 * 一旦写进去就只能靠手动清扩展存储才能删掉，这对一个把简历发给第三方 AI 的扩展
 * 来说不合适。
 */
const resetState = ref<'idle' | 'confirm' | 'running' | 'done'>('idle')
const resetError = ref('')

async function clearAllData() {
  if (resetState.value === 'confirm') {
    resetState.value = 'running'
    resetError.value = ''
    try {
      await resetAllStorage()
      resetState.value = 'done'
    }
    catch (error) {
      resetState.value = 'idle'
      resetError.value = error instanceof Error ? error.message : String(error)
    }
    return
  }
  resetState.value = 'confirm'
}
</script>

<template>
  <!--
    整页交给 ScrollArea：设置页内容比视口长得多，原生滚动条常显又占宽度。
    注意滚动条是「浮在内容之上」的，所以内容自带 `max-w-3xl` 居中 + 左右留白，
    不至于被它压住（设置页本来就有这层留白）。
  -->
  <ScrollArea class="h-screen bg-gray-50 text-gray-800" scroller-class="px-6 py-10">
    <div class="mx-auto max-w-3xl">
      <!-- 头部 -->
      <header class="mb-8 flex items-center gap-3">
        <img :src="logo" class="h-12 w-12" alt="Offer Hunter">
        <div>
          <h1 class="text-xl font-semibold text-teal-700">
            Offer Hunter
          </h1>
          <p class="text-sm text-gray-500">
            自动在 BOSS 直聘找工作：AI 分析 JD 匹配度，匹配度高时生成定制打招呼语
          </p>
        </div>
      </header>

      <!-- 标签 -->
      <nav class="mb-6 flex gap-1 border-b border-gray-200 text-sm">
        <button
          v-for="t in ([
            ['resume', '简历'],
            ['greeting', '打招呼'],
            ['ai', 'AI 平台'],
          ] as const)"
          :key="t[0]"
          class="-mb-px border-b-2 px-4 py-2 transition"
          :class="tab === t[0]
            ? 'border-teal-600 font-medium text-teal-700'
            : 'border-transparent text-gray-500 hover:text-gray-700'"
          @click="tab = t[0]"
        >
          {{ t[1] }}
        </button>
      </nav>

      <!-- 简历 -->
      <section v-if="tab === 'resume'" class="space-y-4 rounded-lg bg-white p-6 shadow-sm">
        <div class="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <strong>隐私提示：</strong>简历内容会随 JD 一起发送给你所配置的第三方 AI 平台。
          若简历含手机号、身份证号等敏感信息，建议先脱敏。
        </div>

        <div>
          <div class="mb-1 flex items-center justify-between text-sm text-gray-600">
            <span>简历全文（Markdown）</span>
            <span class="text-xs text-gray-400">
              {{ resume.markdown.length }} 字
              <template v-if="resume.updatedAt">
                · 更新于 {{ new Date(resume.updatedAt).toLocaleString() }}
              </template>
            </span>
          </div>
          <MarkdownEditor
            v-model="resume.markdown"
            @submit="touchResume"
          />
        </div>

        <p class="text-xs text-gray-400">
          编辑器为 Monaco + Shiki 高亮（vitesse-dark 主题），支持 Markdown 语法着色与撤销栈。
          内容改动会自动保存；Cmd/Ctrl + Enter 可手动触发一次保存时间戳更新。
        </p>
      </section>

      <!-- 打招呼 -->
      <section v-else-if="tab === 'greeting'" class="space-y-6">
        <div class="space-y-3 rounded-lg bg-white p-6 shadow-sm">
          <label class="block">
            <span class="mb-1 flex items-center justify-between text-sm text-gray-600">
              <span>打招呼语提示词</span>
              <button
                v-if="matching.greetingPrompt"
                class="text-xs text-gray-400 hover:text-gray-600"
                @click="matching.greetingPrompt = ''"
              >
                清空
              </button>
            </span>
            <!--
              提示词会长到十几行：固定高度 + 内部滚动，比让 textarea 自己撑高更可控。
              `resize-none` 是因为拖拽手柄与自绘滚动条会挤在同一个角上。
            -->
            <ScrollArea class="oh-prompt h-44" scroller-class="oh-prompt-pad">
              <textarea
                v-model="matching.greetingPrompt"
                class="oh-prompt-input font-mono text-xs leading-relaxed"
                placeholder="自定义生成规则，每行一条，例如：&#10;开头使用「您好」&#10;突出我的开源经历&#10;控制在 80 字以内"
              />
            </ScrollArea>
          </label>
          <p class="text-xs text-gray-400">
            这些规则会作为「额外要求」追加到生成招呼语的提示词里，
            <strong>优先级高于默认要求</strong>（冲突时以你的规则为准）。留空表示不加额外约束。
          </p>
        </div>

        <div class="space-y-4 rounded-lg bg-white p-6 shadow-sm">
          <div>
            <span class="mb-1 flex items-center justify-between text-sm text-gray-600">
              <span>匹配度阈值</span>
              <span class="font-medium text-teal-700">{{ matching.scoreThreshold }}</span>
            </span>
            <input
              v-model.number="matching.scoreThreshold"
              type="range"
              min="0"
              max="100"
              class="w-full"
            >
            <p class="mt-1 text-xs text-gray-400">
              匹配度达到该值才建议生成招呼语。
            </p>
          </div>

          <div class="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            <strong>风控提示：</strong>短时间内高频打招呼、给同一人重复发消息，
            都是平台风控的高危行为。建议从小额度开始观察账号状态。
          </div>
        </div>
      </section>

      <!-- AI 平台 -->
      <section v-else class="space-y-5 rounded-lg bg-white p-6 shadow-sm">
        <div>
          <span class="mb-2 block text-sm text-gray-600">平台</span>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="opt in AI_PLATFORM_OPTIONS"
              :key="opt.value"
              class="rounded border p-2.5 text-left text-sm transition"
              :class="ai.platform === opt.value
                ? 'border-teal-600 bg-teal-50'
                : 'border-gray-200 hover:border-gray-300'"
              @click="setPlatform(opt.value)"
            >
              <div class="font-medium" :class="ai.platform === opt.value ? 'text-teal-700' : ''">
                {{ opt.label }}
              </div>
              <div class="mt-0.5 text-xs text-gray-500">
                {{ opt.hint }}
              </div>
            </button>
          </div>
        </div>

        <label class="block">
          <span class="mb-1 block text-sm text-gray-600">API Key</span>
          <input
            v-model="ai.apiKey"
            type="password"
            class="oh-input font-mono"
            placeholder="sk-..."
            autocomplete="off"
          >
          <span class="mt-1 block text-xs text-gray-400">
            ⚠ 存储在 chrome.storage.local，<strong>未加密</strong>。能读取本机浏览器数据的人即可拿到。
            建议使用设了额度上限的 Key，而不是主账号的全权 Key。
          </span>
        </label>

        <div class="grid grid-cols-2 gap-4">
          <label class="block">
            <span class="mb-1 block text-sm text-gray-600">模型</span>
            <input v-model="ai.model" class="oh-input font-mono" placeholder="留空用平台默认">
          </label>
          <label class="block">
            <span class="mb-1 block text-sm text-gray-600">最大输出 Token</span>
            <input v-model.number="ai.maxTokens" type="number" min="256" class="oh-input">
          </label>
        </div>

        <label class="block">
          <span class="mb-1 block text-sm text-gray-600">接口地址（可选）</span>
          <input v-model="ai.baseUrl" class="oh-input font-mono" placeholder="留空用平台默认地址">
          <span class="mt-1 block text-xs text-gray-400">{{ platformHint }}</span>
        </label>

        <!-- 连通性测试 -->
        <div class="rounded-lg border border-gray-200 p-3">
          <div class="flex items-center gap-3">
            <button
              class="oh-btn-primary"
              :disabled="test.status === 'testing'"
              @click="runTest"
            >
              {{ test.status === 'testing' ? '测试中…' : '测试连通性' }}
            </button>
            <span class="text-xs text-gray-500">
              发一条极短请求，验证接口地址、API Key、模型名三者是否都可用
            </span>
          </div>

          <div
            v-if="test.status === 'ok'"
            class="mt-3 rounded border border-teal-200 bg-teal-50 p-2.5 text-xs text-teal-800"
          >
            <p class="flex items-center gap-1.5 font-medium">
              <span class="i-tabler-circle-check text-sm" />
              连接正常（{{ test.latencyMs }} ms）
            </p>
            <p class="mt-1 text-teal-700">
              平台 {{ test.provider }} · 模型 {{ test.model }}
            </p>
            <p class="mt-0.5 text-teal-700">
              模型回显：{{ test.reply }}
            </p>
          </div>

          <div
            v-else-if="test.status === 'fail'"
            class="mt-3 rounded border border-red-200 bg-red-50 p-2.5 text-xs text-red-700"
          >
            <p class="flex items-center gap-1.5 font-medium">
              <span class="i-tabler-alert-triangle text-sm" />
              连接失败
            </p>
            <p v-if="test.provider" class="mt-1">
              平台 {{ test.provider }} · 模型 {{ test.model || '(未指定，使用平台默认)' }}
            </p>
            <p class="mt-1 break-all">
              {{ test.error }}
            </p>
          </div>
        </div>

        <p class="text-xs text-gray-400">
          AI 请求由扩展后台发出，API Key 不会进入网页上下文。
        </p>

        <!-- 数据管理 -->
        <div class="rounded-lg border border-red-200 bg-red-50/60 p-4">
          <h3 class="text-sm font-medium text-red-800">
            清空本地数据
          </h3>
          <p class="mt-1 text-xs text-red-700/80">
            删除本扩展保存的全部内容：简历、API Key、平台配置与岗位账本。
            浏览器里的 BOSS 登录状态不受影响。
          </p>
          <div class="mt-3 flex items-center gap-3">
            <button
              class="oh-btn-danger"
              :disabled="resetState === 'running'"
              @click="clearAllData"
            >
              {{ resetState === 'running' ? '正在清空…' : (resetState === 'confirm' ? '确认清空（不可恢复）' : '清空全部数据') }}
            </button>
            <button
              v-if="resetState === 'confirm'"
              class="text-xs text-gray-500 hover:text-gray-700"
              @click="resetState = 'idle'"
            >
              取消
            </button>
            <span v-if="resetState === 'done'" class="text-xs text-teal-700">
              已清空，刷新页面后生效。
            </span>
          </div>
          <p v-if="resetError" class="mt-2 text-xs text-red-700">
            清空失败：{{ resetError }}
          </p>
        </div>
      </section>
    </div>
  </ScrollArea>
</template>

<style scoped>
.oh-input {
  width: 100%;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  padding: 0.4rem 0.6rem;
  font-size: 0.875rem;
  background: #fff;
  outline: none;
  transition: border-color 0.15s;
}
.oh-input:focus {
  border-color: #0d9488;
  box-shadow: 0 0 0 2px rgba(13, 148, 136, 0.15);
}
/*
  提示词输入框：滚动交给 ScrollArea，textarea 自身只填满那块可视区。
  内边距放在滚动层上（而不是 textarea 上），否则文字会相对其它输入框缩进一格。

  ⚠ 内边距必须用 `:deep()` 打进去：`scrollerClass` 是给 ScrollArea **内部**那个滚动层加的，
  而它带的是 ScrollArea 自己的 scoped hash，本文件里普通的 `.oh-prompt-pad` 选择器
  （会编译成 `.oh-prompt-pad[data-v-本文件]`）永远匹配不上 —— 表现为 padding 直接消失。
  见 components/README.md 的「scrollerClass 的两条限制」。
*/
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
.oh-btn-primary {
  background: #0d9488;
  border: none;
  border-radius: 0.375rem;
  padding: 0.4rem 1rem;
  color: #fff;
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 0.15s;
}
.oh-btn-primary:hover:not(:disabled) {
  background: #0f766e;
}
.oh-btn-primary:disabled {
  opacity: 0.6;
  cursor: default;
}
.oh-btn-danger {
  border: 1px solid #dc2626;
  border-radius: 0.375rem;
  padding: 0.4rem 1rem;
  background: #fff;
  color: #b91c1c;
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 0.15s;
}
.oh-btn-danger:hover:not(:disabled) {
  background: #dc2626;
  color: #fff;
}
.oh-btn-danger:disabled {
  opacity: 0.6;
  cursor: default;
}
.oh-editor-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 420px;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  color: #6b7280;
}
</style>
