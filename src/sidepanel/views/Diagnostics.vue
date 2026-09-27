<script setup lang="ts">
import type { DiagnosticResult } from '~/logic/types'

/**
 * 诊断面板：真机复验接口契约与 DOM 选择器。
 *
 * 存在的理由：本项目的接口字段与选择器来自社区实测记录，平台改版即失效。
 * 与其写一次性脚本，不如把它做成面板里的常驻功能 —— 改版后能立刻定位坏在哪。
 */

/**
 * 默认值兜底：父组件漏传 props 时组件会静默白屏，
 * 给默认值可以让它退化成空状态而不是整块 UI 消失。
 */
withDefaults(defineProps<{
  result?: DiagnosticResult | null
  running?: boolean
}>(), {
  result: null,
  running: false,
})

defineEmits<{ run: [] }>()

function shortUrl(url: string): string {
  try {
    const u = new URL(url, location.origin)
    return u.pathname.replace('/wapi/zpgeek/', '')
  }
  catch {
    return url
  }
}
</script>

<template>
  <div class="p-3 text-xs">
    <button
      class="oh-btn-primary mb-3 w-full rounded py-1.5"
      :disabled="running"
      @click="$emit('run')"
    >
      {{ running ? '诊断中…' : '运行诊断' }}
    </button>

    <p class="mb-3 text-gray-500">
      诊断会复验接口契约与页面选择器，用于定位平台改版导致的失效。
    </p>

    <template v-if="result">
      <!-- 已捕获的接口 -->
      <section class="mb-4">
        <h3 class="mb-1 font-medium text-gray-700">
          已捕获接口 ({{ result.capturedApis.length }})
        </h3>
        <p v-if="result.capturedApis.length === 0" class="text-gray-400">
          暂无。请刷新 BOSS 职位列表页。
        </p>
        <ul v-else class="space-y-1">
          <li
            v-for="c in result.capturedApis"
            :key="c.url"
            class="rounded border p-1.5"
            :class="c.ok ? 'border-teal-200 bg-teal-50' : 'border-red-200 bg-red-50'"
          >
            <div class="font-mono text-[10px] break-all">
              {{ shortUrl(c.url) }}
            </div>
            <div v-if="c.ok" class="mt-0.5 text-gray-500">
              字段: {{ c.keys.join(', ') }}
            </div>
            <div v-else class="mt-0.5 text-red-600">
              {{ c.error }}
            </div>
          </li>
        </ul>
      </section>

      <!-- 岗位捕获 -->
      <section class="mb-4">
        <h3 class="mb-1 font-medium text-gray-700">
          岗位捕获
        </h3>
        <div
          class="rounded border p-2"
          :class="result.hasCurrentJob ? 'border-teal-200 bg-teal-50' : 'border-gray-200 bg-gray-50'"
        >
          <p class="flex items-center gap-1.5">
            <span
              class="text-sm"
              :class="result.hasCurrentJob ? 'i-tabler-circle-check text-teal-600' : 'i-tabler-alert-circle text-gray-400'"
            />
            <span>当前岗位：{{ result.currentJobName ?? '尚未捕获（请在职位页点开一个岗位）' }}</span>
          </p>
          <p v-if="result.hasCurrentJob" class="mt-0.5 text-gray-500">
            来源：{{ result.currentJobSource === 'api' ? '详情接口 ✓' : 'DOM 回退（薪资等字段可能缺失）' }}
            · JD {{ result.jdLength }} 字
          </p>
          <p v-if="result.domOutline" class="mt-0.5 text-gray-500">
            DOM 读到：岗位名「{{ result.domOutline.jobName || '未命中' }}」·
            公司「{{ result.domOutline.brandName || '未命中' }}」
          </p>
        </div>
      </section>

      <!-- 详情接口契约 -->
      <section class="mb-4">
        <h3 class="mb-1 font-medium text-gray-700">
          详情接口契约
        </h3>
        <div v-if="!result.detailProbe" class="text-gray-400">
          没有可探测的岗位（尚未捕获到 securityId）
        </div>
        <div
          v-else
          class="rounded border p-2"
          :class="result.detailProbe.hasPostDescription
            ? 'border-teal-200 bg-teal-50'
            : 'border-amber-200 bg-amber-50'"
        >
          <p class="flex items-center gap-1.5">
            <span class="text-sm" :class="result.detailProbe.ok ? 'i-tabler-circle-check text-teal-600' : 'i-tabler-alert-triangle text-red-500'" />
            securityId → {{ result.detailProbe.ok ? '请求成功' : '请求失败' }}
          </p>
          <p class="flex items-center gap-1.5">
            <span
              class="text-sm"
              :class="result.detailProbe.hasPostDescription ? 'i-tabler-circle-check text-teal-600' : 'i-tabler-alert-triangle text-red-500'"
            />
            jobInfo.postDescription → {{ result.detailProbe.hasPostDescription ? '有内容' : '为空' }}
          </p>
          <p v-if="result.detailProbe.jdPreview" class="mt-1 text-gray-500">
            预览：{{ result.detailProbe.jdPreview }}…
          </p>
          <p v-if="result.detailProbe.error" class="mt-1 text-red-600">
            {{ result.detailProbe.error }}
          </p>
        </div>
      </section>

      <!-- 选择器命中 -->
      <section class="mb-4">
        <h3 class="mb-1 font-medium text-gray-700">
          选择器命中
        </h3>
        <ul class="space-y-0.5">
          <li
            v-for="s in result.selectors"
            :key="s.key"
            class="flex items-center justify-between rounded px-1.5 py-1"
            :class="s.found ? 'bg-teal-50' : 'bg-red-50'"
          >
            <span class="text-gray-700">{{ s.key }}</span>
            <span :class="s.found ? 'text-teal-700' : 'text-red-600'">
              {{ s.found ? `命中 ${s.count}` : '未命中' }}
            </span>
          </li>
        </ul>
      </section>

      <!-- 环境 -->
      <section>
        <h3 class="mb-1 font-medium text-gray-700">
          环境
        </h3>
        <p class="break-all text-gray-500">
          {{ result.url }}
        </p>
        <p class="text-gray-500">
          已捕获接口 {{ result.capturedApis.length }} 个
        </p>
      </section>
    </template>
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
