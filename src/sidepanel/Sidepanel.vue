<script setup lang="ts">
import type { DiagnosticResult, JobRecord, JobView, MatchingSettings, MatchResult } from '~/logic/types'
import type { GreetingResult } from '~/platform/ai/matching'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { JOBS_PAGE_URL } from '~/logic/boss/selectors'
import { callBackground } from '~/logic/messaging'
import { STORAGE_KEYS, useStoredValue } from '~/logic/storage'
import { createDefaultMatchingSettings } from '~/logic/types'
import {
  currentJob,
  diagnostic,
  listenForJobChanges,
  listenForTabChanges,
  notice,
  pageState,
  records,
  refreshCurrentJob,
  refreshPageState,
  setNotice,
  syncRecords,
} from './state'
import Diagnostics from './views/Diagnostics.vue'
import JobDetailCard from './views/JobDetailCard.vue'
import QuickSettings from './views/QuickSettings.vue'

/**
 * 侧边栏主体：当前岗位详情 + 匹配流程 + 诊断 + 快捷设置。
 *
 * 与页面内悬浮面板相比，这里是**浏览器原生侧边栏**：
 * 定位、层级、遮挡全部由浏览器处理，不会再与 BOSS 自己的悬浮按钮冲突。
 *
 * 代价是侧边栏没有页面访问权，因此岗位数据要经后台转发给内容脚本获取。
 */

type Tab = 'job' | 'diagnostics' | 'settings'
const tab = ref<Tab>('job')

const matching = useStoredValue<MatchingSettings>(
  STORAGE_KEYS.matching,
  createDefaultMatchingSettings,
)

/** 用户是否手动切换过标签 —— 自动跳转只在用户没干预时发生 */
const userSwitchedTab = ref(false)
function selectTab(t: Tab) {
  tab.value = t
  userSwitchedTab.value = true
}

const record = computed<JobRecord | null>(() => {
  const job = currentJob.value
  if (!job?.securityId)
    return null
  return records[job.securityId] ?? null
})

const busy = ref({ matching: false, greeting: false })

let pollTimer: ReturnType<typeof setInterval> | null = null
let stopJobPush: (() => void) | null = null
let stopTabWatch: (() => void) | null = null

/** 首次拿到岗位不算「切换」，避免一打开侧边栏就弹无意义提示 */
let seenFirstJob = false

/** 岗位的身份标识：优先 securityId，兜底用 JD 文本 */
function jobKey(job: JobView | null | undefined): string | null {
  if (!job)
    return null
  return job.securityId || job.jdText || null
}

/** 岗位确实换了才提示，并（在用户没手动切过标签时）跳回「岗位」页 */
function announceSwitch(previousKey: string | null): void {
  const nextKey = jobKey(currentJob.value)
  if (nextKey === null || nextKey === previousKey)
    return

  if (!seenFirstJob) {
    seenFirstJob = true
    return
  }

  if (!userSwitchedTab.value)
    tab.value = 'job'
  setNotice('已切换到新岗位', 'info')
}

/**
 * 轮询兜底。
 *
 * 主路径是内容脚本的主动推送（listenForJobChanges）。轮询只在推送丢失时
 * （例如内容脚本刚被重载）把状态追回来，因此间隔可以放得很长。
 */
async function poll() {
  const previousKey = jobKey(currentJob.value)
  await refreshCurrentJob()
  announceSwitch(previousKey)
}

/**
 * 手动刷新：忽略内容脚本的缓存，强制重新取数。
 *
 * 与 poll 的区别就在这个 force —— 内容脚本内存里可能是旧的/只有 JD 的占位岗位，
 * 普通轮询只会把那份缓存再读一遍，点了等于没点。
 */
async function forceRefresh() {
  const previousKey = jobKey(currentJob.value)
  await refreshCurrentJob(true)
  announceSwitch(previousKey)
}

/** 内容脚本推来的岗位变化 */
function onJobPushed(job: JobView | null) {
  const previousKey = jobKey(currentJob.value)
  currentJob.value = job
  // 顺手校正一次「当前标签页是不是 BOSS」：推送只可能来自 BOSS 页面，
  // 但面板的 pageState 可能还是「从别的标签切过来时」的旧值 ——
  // 那会让通知说「已切换到新岗位」，主体却还写着「当前标签页不是 BOSS 直聘」。
  void refreshPageState()
  announceSwitch(previousKey)
}

const POLL_INTERVAL_MS = 10_000

onMounted(async () => {
  await syncRecords()
  // 首次直接刷新，不走「切换」提示逻辑
  await refreshCurrentJob()
  if (currentJob.value)
    seenFirstJob = true

  stopJobPush = listenForJobChanges(onJobPushed)
  // 标签切换 / 地址变化 / 加载完成都重新取一次，不再等 10s 兜底轮询
  stopTabWatch = listenForTabChanges(() => {
    void poll()
  })
  pollTimer = setInterval(poll, POLL_INTERVAL_MS)
})

onUnmounted(() => {
  if (pollTimer)
    clearInterval(pollTimer)
  stopJobPush?.()
  stopJobPush = null
  stopTabWatch?.()
  stopTabWatch = null
})

async function persist(patch: Partial<JobRecord>) {
  const job = currentJob.value
  if (!job?.securityId)
    return
  const existing = records[job.securityId]
  const next: JobRecord = {
    securityId: job.securityId,
    jobName: job.jobName,
    brandName: job.brandName,
    bossName: job.bossName,
    salaryDesc: job.salaryDesc,
    status: existing?.status ?? 'found',
    match: existing?.match ?? null,
    greeting: existing?.greeting ?? null,
    error: null,
    firstSeen: existing?.firstSeen ?? new Date().toISOString(),
    ...patch,
  }
  records[job.securityId] = next
  try {
    await callBackground('upsert-record', next)
  }
  catch (error) {
    console.warn('[offer-hunter] 写入账本失败', error)
  }
}

async function runMatch() {
  const job = currentJob.value
  if (!job || busy.value.matching)
    return
  if (!job.jdText.trim()) {
    setNotice('当前岗位没有 JD 内容，无法分析', 'error')
    return
  }

  busy.value.matching = true
  setNotice(`正在分析「${job.jobName}」…`)

  try {
    const res = await callBackground<{ ok: boolean, data?: MatchResult, error?: string }>(
      'ai-match',
      { job, jdText: job.jdText },
    )
    if (!res.ok) {
      await persist({ status: 'failed', error: res.error })
      setNotice(res.error, 'error')
      return
    }

    const match = res.data as MatchResult
    const threshold = matching.value.scoreThreshold
    const passed = match.score >= threshold
    await persist({ match, status: passed ? 'scored' : 'skipped', error: null })
    setNotice(
      passed
        ? `匹配度 ${match.score}（阈值 ${threshold}）：${match.summary}`
        : `匹配度 ${match.score}，低于阈值 ${threshold}：${match.summary}`,
      passed ? 'success' : 'info',
    )
  }
  catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await persist({ status: 'failed', error: msg })
    setNotice(msg, 'error')
  }
  finally {
    busy.value.matching = false
  }
}

async function runGreeting() {
  const job = currentJob.value
  if (!job || busy.value.greeting)
    return

  busy.value.greeting = true
  setNotice('正在生成招呼语…')

  try {
    const res = await callBackground<{ ok: boolean, data?: GreetingResult, error?: string }>(
      'ai-greeting',
      { job, jdText: job.jdText, match: record.value?.match ?? null },
    )
    if (!res.ok) {
      setNotice(res.error, 'error')
      return
    }
    await persist({ greeting: res.data.greeting, status: 'drafted' })
    setNotice('招呼语已生成，点「复制」后到 BOSS 粘贴发送', 'success')
  }
  catch (error) {
    setNotice(error instanceof Error ? error.message : String(error), 'error')
  }
  finally {
    busy.value.greeting = false
  }
}

function copyGreeting() {
  const text = record.value?.greeting
  if (!text)
    return
  navigator.clipboard.writeText(text)
    .then(() => setNotice('已复制到剪贴板', 'success'))
    .catch(() => setNotice('复制失败，请手动选择文本', 'error'))
}

async function runDiagnostic() {
  diagnostic.running = true
  try {
    const res = await callBackground<{ ok: boolean, result?: DiagnosticResult, reason?: string }>(
      'relay-diagnostic',
    )
    if (res?.ok) {
      diagnostic.result = res.result ?? null
      setNotice('诊断完成', 'success')
    }
    else {
      setNotice(res?.reason ?? '诊断失败', 'error')
    }
  }
  catch (error) {
    setNotice(error instanceof Error ? error.message : String(error), 'error')
  }
  finally {
    diagnostic.running = false
  }
}

function openOptions() {
  browser.runtime.openOptionsPage()
}

function openJobsPage() {
  browser.tabs.create({ url: JOBS_PAGE_URL })
}
</script>

<template>
  <div class="relative flex h-screen flex-col bg-white text-gray-800">
    <!-- 顶部固定栏（毛玻璃） -->
    <div class="oh-topbar sticky top-0 z-10 shrink-0">
      <!--
        标签与操作图标同一行、左右分开对齐（justify-between），省掉一整行纵向空间。
        不放扩展图标与产品名：浏览器侧边栏自身已经显示了，重复只是浪费空间。
      -->
      <header class="flex items-center justify-between gap-2 px-2 py-1.5">
        <nav class="flex items-center gap-1 text-xs">
          <button
            v-for="t in ([['job', '岗位'], ['diagnostics', '诊断'], ['settings', '设置']] as const)"
            :key="t[0]"
            class="rounded px-2.5 py-1 transition"
            :class="tab === t[0]
              ? 'bg-teal-50 font-medium text-teal-700'
              : 'text-gray-500 hover:bg-gray-100/70'"
            @click="selectTab(t[0])"
          >
            {{ t[1] }}
          </button>
        </nav>

        <div class="flex shrink-0 items-center gap-0.5">
          <button class="oh-icon-btn" title="刷新当前岗位" @click="forceRefresh">
            <span class="i-tabler-refresh text-base" />
          </button>
          <button class="oh-icon-btn" title="设置页" @click="openOptions">
            <span class="i-tabler-settings text-base" />
          </button>
        </div>
      </header>

      <!-- 提示条：绝对定位，不挤占内容高度 -->
      <Transition name="oh-toast">
        <div
          v-if="notice.text"
          class="oh-toast absolute inset-x-0 top-full flex items-start gap-1.5 px-3 py-1.5 text-xs shadow-sm"
          :class="{
            'bg-red-50/95 text-red-700': notice.kind === 'error',
            'bg-teal-50/95 text-teal-700': notice.kind === 'success',
            'bg-gray-100/95 text-gray-600': notice.kind === 'info',
          }"
        >
          <span
            class="mt-[2px] shrink-0 text-sm"
            :class="{
              'i-tabler-alert-triangle': notice.kind === 'error',
              'i-tabler-circle-check': notice.kind === 'success',
              'i-tabler-info-circle': notice.kind === 'info',
            }"
          />
          <span class="min-w-0">{{ notice.text }}</span>
        </div>
      </Transition>
    </div>

    <!-- 内容 -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="tab === 'job'" class="p-3">
        <!-- 不在 BOSS 页面 -->
        <div v-if="!pageState.onBoss" class="px-2 py-8 text-center">
          <span class="i-tabler-world-off mx-auto mb-3 block text-3xl text-gray-300" />
          <p class="text-xs text-gray-500">
            当前标签页不是 BOSS 直聘。<br>
            请先在 BOSS 上打开一个职位页面。
          </p>
          <button class="oh-btn oh-btn-primary mt-3" @click="openJobsPage">
            打开 BOSS 职位页
          </button>
        </div>

        <!-- 在 BOSS 页面但还没点开岗位 -->
        <div v-else-if="!currentJob.value" class="px-2 py-8 text-center">
          <span class="i-tabler-hand-click mx-auto mb-3 block text-3xl text-gray-300" />
          <p class="text-xs text-gray-500">
            还没有选中岗位。<br><br>
            请在 BOSS 职位列表里<strong class="text-gray-600">点击任意岗位卡片</strong>，
            这里会自动显示该岗位的详情与匹配分析。
          </p>
        </div>

        <JobDetailCard
          v-else
          :job="currentJob.value"
          :record="record"
          :busy="busy"
          @match="runMatch"
          @greeting="runGreeting"
          @copy="copyGreeting"
        />
      </div>

      <Diagnostics
        v-else-if="tab === 'diagnostics'"
        :result="diagnostic.result"
        :running="diagnostic.running"
        @run="runDiagnostic"
      />

      <QuickSettings v-else />
    </div>
  </div>
</template>

<style scoped>
.oh-topbar {
  background: rgba(255, 255, 255, 0.78);
  backdrop-filter: blur(12px) saturate(180%);
  -webkit-backdrop-filter: blur(12px) saturate(180%);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.oh-toast {
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
}
.oh-toast-enter-active,
.oh-toast-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.oh-toast-enter-from,
.oh-toast-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.oh-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.625rem;
  height: 1.625rem;
  border-radius: 0.375rem;
  border: none;
  background: transparent;
  color: #6b7280;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}
.oh-icon-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #111827;
}

.oh-btn {
  padding: 0.35rem 0.75rem;
  border: 1px solid #d1d5db;
  border-radius: 0.25rem;
  background: #fff;
  color: #374151;
  font-size: 0.75rem;
  cursor: pointer;
  transition: all 0.15s;
}
.oh-btn:hover:not(:disabled) {
  border-color: #0d9488;
  color: #0d9488;
}
.oh-btn-primary {
  background: #0d9488;
  border-color: #0d9488;
  color: #fff;
}
.oh-btn-primary:hover:not(:disabled) {
  background: #0f766e;
  border-color: #0f766e;
  color: #fff;
}
</style>
