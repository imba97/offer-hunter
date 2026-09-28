<script setup lang="ts">
import type { AiSettings, Resume } from '~/logic/types'
import { computed, ref } from 'vue'
import { callBackground } from '~/logic/messaging'
import { STORAGE_KEYS, useStoredValue } from '~/logic/storage'
import { createDefaultAiSettings, createEmptyResume } from '~/logic/types'

/**
 * 侧边栏的快捷设置。
 *
 * 定位：只放**当前会话里要确认一眼**的东西 —— 两项就绪状态与连通性测试，
 * 以及通往设置页的入口。简历、API Key、平台选择、提示词这类
 * 「配一次就不动」的内容都在设置页。
 *
 * 曾经这里还有个「匹配阈值」滑块，那是自动流程的产物（低于阈值就跳过岗位）。
 * 现在每一步都由用户自己决定，阈值没有消费方，已移除。
 */

const ai = useStoredValue<AiSettings>(STORAGE_KEYS.ai, createDefaultAiSettings)
const resume = useStoredValue<Resume>(STORAGE_KEYS.resume, createEmptyResume)

const resumeReady = computed(() => resume.value.markdown.trim().length > 0)
const aiReady = computed(() => (ai.value.apiKey ?? '').trim().length > 0)

const testState = ref<{ status: 'idle' | 'testing' | 'ok' | 'fail', message: string }>({
  status: 'idle',
  message: '',
})

async function runTest() {
  testState.value = { status: 'testing', message: '测试中…' }
  try {
    const res = await callBackground<{ ok: boolean, latencyMs?: number, model?: string, reply?: string, error?: string }>('ai-test')
    testState.value = res.ok
      ? {
          status: 'ok',
          message: `连接正常（${res.latencyMs ?? 0} ms）· ${res.model ?? ''} · 回显 ${res.reply ?? ''}`,
        }
      : { status: 'fail', message: res.error ?? '未知错误' }
  }
  catch (error) {
    testState.value = {
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function openOptions() {
  browser.runtime.openOptionsPage()
}
</script>

<template>
  <div class="p-3 text-xs">
    <!-- 就绪状态 -->
    <section class="mb-4 space-y-1.5">
      <h3 class="mb-1 font-medium text-gray-700">
        就绪状态
      </h3>
      <p class="flex items-center gap-1.5" :class="aiReady ? 'text-teal-700' : 'text-amber-600'">
        <span
          class="text-sm"
          :class="aiReady ? 'i-tabler-circle-check' : 'i-tabler-alert-circle'"
        />
        AI 平台：{{ ai.platform }}{{ ai.model ? ` / ${ai.model}` : '' }}
      </p>
      <p class="flex items-center gap-1.5" :class="resumeReady ? 'text-teal-700' : 'text-amber-600'">
        <span
          class="text-sm"
          :class="resumeReady ? 'i-tabler-circle-check' : 'i-tabler-alert-circle'"
        />
        简历：{{ resumeReady ? `已填写 ${resume.markdown.length} 字` : '尚未填写' }}
      </p>
      <p v-if="!aiReady || !resumeReady" class="text-gray-500">
        两项都就绪后才能进行匹配度分析。
      </p>
    </section>

    <!-- 连通性测试 -->
    <section class="mb-4">
      <h3 class="mb-1 font-medium text-gray-700">
        AI 连通性
      </h3>
      <button
        class="oh-btn-primary w-full rounded py-1.5"
        :disabled="testState.status === 'testing'"
        @click="runTest"
      >
        {{ testState.status === 'testing' ? '测试中…' : '测试连通性' }}
      </button>
      <p
        v-if="testState.status === 'ok'"
        class="mt-1.5 flex items-start gap-1.5 rounded bg-teal-50 p-1.5 text-teal-700"
      >
        <span class="i-tabler-circle-check mt-[1px] shrink-0 text-sm" />
        <span class="min-w-0">{{ testState.message }}</span>
      </p>
      <p
        v-else-if="testState.status === 'fail'"
        class="mt-1.5 flex items-start gap-1.5 rounded bg-red-50 p-1.5 text-red-600"
      >
        <span class="i-tabler-alert-triangle mt-[1px] shrink-0 text-sm" />
        <span class="min-w-0 break-all">{{ testState.message }}</span>
      </p>
    </section>

    <button
      class="oh-btn-primary w-full rounded py-1.5"
      @click="openOptions"
    >
      打开完整设置页
    </button>

    <p class="mt-2 text-gray-400">
      简历、API Key、平台与提示词都在设置页。
    </p>
  </div>
</template>

<style scoped>
.oh-btn-primary {
  background: #0d9488;
  border: none;
  color: #fff;
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
</style>
