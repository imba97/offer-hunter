<script setup lang="ts">
import type { DiagnosticResult, JobRecord, JobView, MatchResult } from '~/logic/types'
import type { GreetingResult } from '~/platform/ai/matching'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ScrollArea from '~/components/ScrollArea.vue'
import { callBackground } from '~/logic/messaging'
import { SITE_DESCRIPTORS, supportedSitesLabel } from '~/sites/routing'
import { MessageBox } from './message-box'
import MessageBoxHost from './MessageBox.vue'
import {
  currentJob,
  currentSiteTabId,
  diagnostic,
  listenForJobChanges,
  listenForTabChanges,
  pageState,
  records,
  refreshCurrentJob,
  refreshPageState,
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

/** 受支持站点的名字（单站点是「BOSS 直聘」，多站点会自动并列） */
const sitesLabel = supportedSitesLabel()

/** 用户是否手动切换过标签 —— 自动跳转只在用户没干预时发生 */
const userSwitchedTab = ref(false)
function selectTab(t: Tab) {
  tab.value = t
  userSwitchedTab.value = true
}

const record = computed<JobRecord | null>(() => {
  const job = currentJob.value
  const key = job?.site.naturalKey
  if (!key)
    return null
  return records[key] ?? null
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
  return job.site.naturalKey || job.jdText || null
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
  // 岗位切换本身已经体现在面板内容上了，提示只作为「刚才发生了什么」的补充
  MessageBox.info('已切换到新岗位')
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
  /*
   * 顺手校正一次「当前标签页是不是我们的站点」：推送只可能来自站点页面，
   * 但面板的 pageState 可能还是「从别的标签切过来时」的旧值 ——
   * 那会让通知说「已切换到新岗位」，主体却还写着「当前标签页不是 X」。
   *
   * ⚠ 这里刻意只校正页面状态，**不**调 refreshCurrentJob：
   *   岗位就是刚推过来的，再回头问一次内容脚本纯属多余，
   *   而且会在推送与拉取之间制造无谓的往返。
   */
  void refreshPageState()
  announceSwitch(previousKey)
}

const POLL_INTERVAL_MS = 10_000

onMounted(async () => {
  /*
   * 先把推送订阅挂上，再取数。
   *
   * 顺序要紧：refreshCurrentJob 要等「tabs.query → 后台 → 内容脚本 → 回来」
   * 整条链路，期间内容脚本完全可能推一次 job-changed 过来 ——
   * 订阅挂晚了那次推送就丢了，面板只能等 10s 兜底轮询。
   */
  stopJobPush = listenForJobChanges(onJobPushed)

  /*
   * refreshCurrentJob 内部会先做一次 tabs.query 把 pageState 摆正（那一步很快），
   * 之后才是较慢的后台转发，所以不必在这里重复查一次标签页。
   * 账本与岗位互不依赖，并行发，少一半等待。
   */
  await Promise.all([syncRecords(), refreshCurrentJob()])

  if (currentJob.value)
    seenFirstJob = true

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
  const key = job?.site.naturalKey
  if (!key)
    return
  const existing = records[key]
  const next: JobRecord = {
    securityId: key,
    title: job.job.title,
    company: job.job.company ?? '',
    recruiterName: job.job.recruiter?.name ?? '',
    salary: job.job.salary ?? '',
    match: existing?.match ?? null,
    greeting: existing?.greeting ?? null,
    error: null,
    firstSeen: existing?.firstSeen ?? new Date().toISOString(),
    ...patch,
  }
  records[key] = next
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
    MessageBox.error('当前岗位没有 JD 内容，无法分析')
    return
  }
  busy.value.matching = true
  // 「正在分析」与随后的结果复用同一条提示：一次操作只该留下一条
  const pending = MessageBox.loading(`正在分析「${job.job.title}」…`)

  try {
    const res = await callBackground<{ ok: boolean, data?: MatchResult, error?: string }>(
      'ai-match',
      { job: job.job, jdText: job.jdText },
    )
    // 与 runGreeting 同理：`res.data as MatchResult` 这种断言正好绕过了「data 可能没有」，
    // 运行时会在 match.score 上炸成一句看不懂的报错，所以这里显式判空
    if (!res.ok || !res.data) {
      await persist({ error: res.error ?? '分析失败：没有拿到结果' })
      MessageBox.update(pending, res.error ?? '分析失败：没有拿到结果', { kind: 'error' })
      return
    }

    const match = res.data
    await persist({ match, error: null })
    // 只有一条成功提示：没有阈值判定，也就没有「达标 / 未达标」两套文案
    MessageBox.update(pending, `匹配度 ${match.score}：${match.summary}`, { kind: 'success' })
  }
  catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await persist({ error: msg })
    MessageBox.update(pending, msg, { kind: 'error' })
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
  const pending = MessageBox.loading('正在生成招呼语…')

  try {
    const res = await callBackground<{ ok: boolean, data?: GreetingResult, error?: string }>(
      'ai-greeting',
      { job: job.job, jdText: job.jdText, match: record.value?.match ?? null },
    )
    // `data` 在类型上是可选的：契约被破坏时（ok=true 但没带内容）不能直接取 .greeting，
    // 那会抛 "Cannot read properties of undefined"，只剩一句看不懂的报错
    if (!res.ok || !res.data) {
      MessageBox.update(pending, res.error ?? '生成失败：没有拿到招呼语内容', { kind: 'error' })
      return
    }
    await persist({ greeting: res.data.greeting })
    MessageBox.update(pending, '招呼语已生成，点「复制」后到 BOSS 粘贴发送', { kind: 'success' })
  }
  catch (error) {
    MessageBox.update(pending, error instanceof Error ? error.message : String(error), { kind: 'error' })
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
    .then(() => MessageBox.success('已复制到剪贴板'))
    .catch(() => MessageBox.error('复制失败，请手动选择文本'))
}

async function runDiagnostic() {
  diagnostic.running = true
  try {
    // 诊断也要指定标签页（与取岗位看同一个），否则后台不知道该问谁
    const tabId = await currentSiteTabId()
    if (tabId === null) {
      MessageBox.error(`当前标签页不是 ${sitesLabel}，无法诊断`)
      return
    }

    const res = await callBackground<{ ok: boolean, result?: DiagnosticResult, reason?: string }>(
      'relay-diagnostic',
      { tabId },
    )
    if (res?.ok) {
      diagnostic.result = res.result ?? null
      MessageBox.success('诊断完成')
    }
    else {
      MessageBox.error(res?.reason ?? '诊断失败')
    }
  }
  catch (error) {
    MessageBox.error(error instanceof Error ? error.message : String(error))
  }
  finally {
    diagnostic.running = false
  }
}

function openOptions() {
  browser.runtime.openOptionsPage()
}

function openJobsPage() {
  // 目标地址来自站点描述，加站点时这里自动生效
  const site = SITE_DESCRIPTORS[0]
  if (site)
    browser.tabs.create({ url: site.jobsPageUrl })
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
    </div>

    <!--
      内容区：滚动条交给 ScrollArea 自绘。
      它同时管三件事：隐藏原生滚动条（宽度恒定，内容不会因为滚动条出现/消失而左右抽动）、
      悬停容器时渐显、悬停到滚动条上再明显一些。
    -->
    <ScrollArea class="min-h-0 flex-1">
      <div class="p-3">
        <div v-if="tab === 'job'">
          <!--
            还没查过标签页时不渲染任何结论：否则面板刚打开的那一瞬间会先闪出
            「当前标签页不是 X」这句其实还没验证过的话。
          -->
          <div v-if="!pageState.checked" class="px-2 py-8 text-center text-xs text-gray-400">
            正在读取当前标签页…
          </div>

          <!-- 已确认不在任何受支持的招聘网站上 -->
          <div v-else-if="!pageState.onSupportedSite" class="px-2 py-8 text-center">
            <span class="i-tabler-world-off mx-auto mb-3 block text-3xl text-gray-300" />
            <p class="text-xs text-gray-500">
              当前标签页不是 {{ sitesLabel }}。<br>
              请先在 {{ sitesLabel }} 上打开一个职位页面。
            </p>
            <button class="oh-btn oh-btn-primary mt-3" @click="openJobsPage">
              打开职位页
            </button>
          </div>

          <!-- 在支持的站点上但还没点开岗位 -->
          <div v-else-if="!currentJob.value" class="px-2 py-8 text-center">
            <span class="i-tabler-hand-click mx-auto mb-3 block text-3xl text-gray-300" />
            <p class="text-xs text-gray-500">
              还没有选中岗位。<br><br>
              请在职位列表里<strong class="text-gray-600">点击任意岗位卡片</strong>，
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
    </ScrollArea>

    <!--
      底部提示条：fixed 浮层，不在内容流里，也不改变滚动区高度。
      曾经给它垫过等高留白（为了「永不被遮」），代价是提示多一条就冒出滚动条、
      少一条又缩回去 —— 滚动条本身占宽，内容跟着左右抽动。遮挡改由交互化解。
    -->
    <MessageBoxHost />
  </div>
</template>

<style scoped>
.oh-topbar {
  background: rgba(255, 255, 255, 0.78);
  backdrop-filter: blur(12px) saturate(180%);
  -webkit-backdrop-filter: blur(12px) saturate(180%);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
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
