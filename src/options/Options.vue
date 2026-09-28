<script setup lang="ts">
import type { AiPlatformName, AiSettings, PromptSettings, Resume, ResumeSourceId } from '~/logic/types'
import { computed, defineAsyncComponent, defineComponent, h, ref } from 'vue'
import logo from '~/assets/logo.png'
import PromptField from '~/components/PromptField.vue'
import ResumeSourcePanel from '~/components/ResumeSourcePanel.vue'
import ScrollArea from '~/components/ScrollArea.vue'
import SecretInput from '~/components/SecretInput.vue'
import { callBackground } from '~/logic/messaging'
import {
  getResumeSource,
  normalizeResumeSource,
  resumeSourceOptions,
} from '~/logic/resume-sources/registry'
import { resetAllStorage, STORAGE_KEYS, useStoredValue } from '~/logic/storage'
import {
  createDefaultAiSettings,
  createDefaultPromptSettings,
  createEmptyResume,
} from '~/logic/types'
import { AI_PLATFORM_OPTIONS } from '~/platform/ai/platforms'

/**
 * 设置页：简历维护 + 提示词 + AI 平台配置。
 *
 * 独立标签页打开，空间充足（侧边栏太窄，放不下编辑器与完整表单）。
 * 简历来源是**可插拔的**（见 logic/resume-sources）：下拉框与来源表单都由注册表
 * 与适配器声明驱动，加一个新来源不需要改本文件。
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

const tab = ref<'resume' | 'prompt' | 'ai'>('resume')

const prompts = useStoredValue<PromptSettings>(
  STORAGE_KEYS.prompts,
  createDefaultPromptSettings,
)

/**
 * 接口地址输入框的 placeholder。
 *
 * 直接写成**当前平台实际会用的那个地址**（而不是把上方卡片的宣传语再抄一遍）：
 * 这个字段真正要回答的问题就是「留空是哪个地址」。
 */
const platformHint = computed(
  () => AI_PLATFORM_OPTIONS.find(o => o.value === ai.value.platform)?.defaultBaseUrl ?? '',
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
// 简历来源
// ---------------------------------------------------------------------------

/**
 * 当前来源。
 *
 * 用可写计算属性而不是直接绑 `resume.sourceId`：存储里可能是 null（早于来源概念的
 * 旧数据）或已废弃的值，读的时候要收敛成「手动输入」，写的时候才落成明确的值。
 */
const resumeMode = computed<ResumeSourceId>({
  get: () => normalizeResumeSource(resume.value.sourceId),
  set: value => (resume.value.sourceId = value),
})

/** 当前来源的适配器 */
const activeSource = computed(() => getResumeSource(resumeMode.value))

/** 下拉框选项：由注册表驱动，加来源不需要改这里 */
const sourceOptions = resumeSourceOptions()

/**
 * 当前来源的配置对象；切换来源时立刻造出完整形状，避免表单读到 undefined
 */
const activeConfig = computed<Record<string, unknown>>(() => {
  const id = resumeMode.value
  return resume.value.sources[id] ?? getResumeSource(id)?.createConfig() ?? {}
})

/**
 * 内容在远端（Gist 这类）还是本地（手动输入）。
 *
 * 从适配器读而不是写 `resumeMode === 'gist'`：那样每加一个来源都要改这里，
 * 而漏改的症状是「远端内容被本地改坏、又不会被同步覆盖」这种静默的不一致。
 */
const remoteContent = computed(() => activeSource.value?.contentSource === 'remote')

function updateSourceConfig(patch: Record<string, unknown>): void {
  resume.value.sources[resumeMode.value] = patch
}

/**
 * 来源同步成功：只写「内容与来源标识」，配置由来源组件自己通过 v-model:config
 * 写回 —— 两边各管一半，不会互相覆盖。
 */
function onSourceSynced(payload: { markdown: string, contentKey: string, label?: string }) {
  const now = new Date().toISOString()
  const changed = resume.value.markdown !== payload.markdown
  resume.value.sourceId = resumeMode.value
  resume.value.markdown = payload.markdown
  resume.value.syncedAt = now
  resume.value.syncedKey = payload.contentKey
  // 只有内容真的变了才动 updatedAt，否则自动同步会一直刷新「更新于」
  if (changed)
    resume.value.updatedAt = now
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
            简历对岗位打分、生成打招呼语；每步都由你触发，发送也由你点
          </p>
        </div>
      </header>

      <!-- 标签 -->
      <nav class="mb-6 flex gap-1 border-b border-gray-200 text-sm">
        <button
          v-for="t in ([
            ['resume', '简历'],
            ['prompt', '提示词'],
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
          <strong>隐私提示：</strong>简历会随 JD 发给第三方 AI 平台，敏感信息请先脱敏。
        </div>

        <label class="block">
          <span class="mb-1 block text-sm text-gray-600">简历来源</span>
          <select v-model="resumeMode" class="oh-input">
            <option v-for="opt in sourceOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <span v-if="activeSource?.hint" class="mt-1 block text-xs text-gray-400">
            {{ activeSource.hint }}
          </span>
        </label>

        <!--
          来源面板：由适配器声明的 configFields 驱动（通用组件，不需要每个来源写界面）。
          只对「内容在远端」的来源渲染 —— 手动输入没有可同步的东西，也没有配置项。
        -->
        <ResumeSourcePanel
          v-if="activeSource && remoteContent"
          :adapter="activeSource"
          :config="activeConfig"
          :synced-at="resume.syncedAt"
          :synced-key="resume.syncedKey"
          @update:config="updateSourceConfig"
          @synced="onSourceSynced"
        />

        <div>
          <div class="mb-1 flex items-center justify-between text-sm text-gray-600">
            <span>{{ remoteContent ? '简历预览（只读）' : '简历全文（Markdown）' }}</span>
            <span class="text-xs text-gray-400">
              {{ resume.markdown.length }} 字
              <template v-if="resume.updatedAt">
                · 更新于 {{ new Date(resume.updatedAt).toLocaleString() }}
              </template>
            </span>
          </div>
          <MarkdownEditor
            v-model="resume.markdown"
            :readonly="remoteContent"
            @submit="touchResume"
          />
        </div>

        <p v-if="remoteContent" class="text-xs text-gray-400">
          此处只读，内容以「{{ activeSource?.label }}」为准；要直接改就把来源切回「手动编辑」。
        </p>
        <p v-else class="text-xs text-gray-400">
          内容改动会自动保存。
        </p>
      </section>

      <!-- 提示词 -->
      <section v-else-if="tab === 'prompt'" class="space-y-6">
        <div class="space-y-5 rounded-lg bg-white p-6 shadow-sm">
          <PromptField
            v-model="prompts.matchPrompt"
            title="匹配度分析提示词"
            placeholder="自定义打分口径，每行一条，例如：&#10;更看重高并发与性能优化经验&#10;有开源贡献可以加分&#10;不看学历"
          >
            <template #hint>
              会追加到匹配分析的提示词里，<strong>优先级高于默认的评判原则</strong>；留空表示只按内置原则打分。
            </template>
          </PromptField>

          <PromptField
            v-model="prompts.greetingPrompt"
            title="打招呼语提示词"
            placeholder="自定义生成规则，每行一条，例如：&#10;开头使用「您好」&#10;突出我的开源经历&#10;控制在 80 字以内"
          >
            <template #hint>
              会追加到招呼语生成的提示词里，<strong>优先级高于默认的写作要求</strong>；留空表示只按内置写法生成。
            </template>
          </PromptField>

          <p class="text-xs text-gray-400">
            两段提示词各管一次 AI 调用：分析只看打分口径，招呼语只看写作规则，互不影响；
            改动立即生效，已分析过的岗位要重新点一次分析才会用上新口径。
          </p>
        </div>

        <div class="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <strong>风控提示：</strong>短时间高频打招呼容易触发平台风控，建议少量多次。
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
          <SecretInput
            v-model="ai.apiKey"
            class="font-mono"
            placeholder="sk-..."
          />
          <span class="mt-1 block text-xs text-amber-700">
            ⚠ 明文存在本机，能读浏览器数据的人就能拿到；建议用设了额度上限的 Key。
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
          <input
            v-model="ai.baseUrl"
            class="oh-input font-mono"
            :placeholder="platformHint ? `留空则用 ${platformHint}` : '留空则用平台默认地址'"
          >
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
              发一条极短请求，验证地址、Key 与模型是否可用
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
              模型回复：{{ test.reply }}
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

        <!-- 数据管理 -->
        <div class="rounded-lg border border-red-200 bg-red-50/60 p-4">
          <h3 class="text-sm font-medium text-red-800">
            清空本地数据
          </h3>
          <p class="mt-1 text-xs text-red-700/80">
            删除简历、提示词、API Key、平台配置与岗位账本；各招聘平台的登录状态不受影响。
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
/* 输入框 / 按钮的样式在 styles/main.css 里共用（见那里的说明），这里只剩编辑器占位 */
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
