<script setup lang="ts">
import type { AiSettings, MatchingSettings, Resume } from '~/logic/types'
import { computed, ref } from 'vue'
import { callBackground } from '~/logic/messaging'
import { STORAGE_KEYS, useStoredValue } from '~/logic/storage'
import {
  createDefaultAiSettings,
  createDefaultMatchingSettings,
  createEmptyResume,
} from '~/logic/types'

/**
 * 侧边栏的快捷设置。
 *
 * 定位：只放**经常需要临时调整**的参数（阈值、限额），调完继续操作不用跳页。
 * 简历、API Key、平台选择、招呼语提示词这类「配一次就不动」的内容都在设置页。
 */

const ai = useStoredValue<AiSettings>(STORAGE_KEYS.ai, createDefaultAiSettings)
const resume = useStoredValue<Resume>(STORAGE_KEYS.resume, createEmptyResume)
const matching = useStoredValue<MatchingSettings>(
  STORAGE_KEYS.matching,
  createDefaultMatchingSettings,
)

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

    <!-- 匹配阈值 -->
    <section class="mb-4">
      <h3 class="mb-1 font-medium text-gray-700">
        匹配阈值
      </h3>
      <div class="flex items-center gap-2">
        <input
          v-model.number="matching.scoreThreshold"
          type="range"
          min="0"
          max="100"
          class="flex-1"
        >
        <span class="w-8 text-right font-medium text-teal-700">{{ matching.scoreThreshold }}</span>
      </div>
      <p class="mt-1 text-gray-400">
        匹配度达到该值才建议生成招呼语。
      </p>
    </section>

    <button
      class="oh-btn-primary w-full rounded py-1.5"
      @click="openOptions"
    >
      打开完整设置页
    </button>

    <p class="mt-2 text-gray-400">
      简历、API Key、平台与招呼语提示词都在设置页。
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
