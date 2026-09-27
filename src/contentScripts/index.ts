/* eslint-disable no-console */
import type { DiagnosticResult } from '~/logic/types'
import { onMessage } from 'webext-bridge/content-script'
import { fetchJobDetail, fetchJobView } from '~/logic/boss/api'
import { buildDomFallbackJob, readJdFromDom, readJobOutlineFromDom } from '~/logic/boss/dom'
import {
  JOB_COMPANY_SELECTORS,
  JOB_DETAIL_BOX,
  JOB_DETAIL_DESC,
  JOB_TITLE_SELECTORS,
  securityIdFromUrl,
} from '~/logic/boss/selectors'
import {
  capturedApis,
  currentJob,
  installInjectedListener,
  watchJdChanges,
} from './state'

/**
 * 内容脚本（隔离世界）。
 *
 * 界面全部在侧边栏，这里**只做与 BOSS 页面打交道的事**：
 *  1. 接收 MAIN world 注入脚本 postMessage 过来的接口数据（见 state.ts）
 *  2. 为侧边栏代发 /wapi/ 请求（只有内容脚本能携带页面 Cookie）
 *
 * ⚠ 刻意**没有任何写入操作**：不点击、不代填输入框。
 * 招呼语由用户从侧边栏复制后自行粘贴发送，侵入性最低。
 */

installInjectedListener()

// 兜底：详情接口没捕获到时，从详情面板的文本更新 JD
watchJdChanges()

/** 上次主动补拉的 securityId 与时间（见 resolveCurrentJob 的冷却逻辑） */
let lastFetch: { securityId: string, at: number } | null = null

/** 强制刷新时，同一个 securityId 的重复请求冷却 */
const REFETCH_COOLDOWN_MS = 10_000

/**
 * 读取当前岗位。
 *
 * 常规调用（`force = false`）在已有岗位时直接返回；**强制刷新**（面板上点「刷新当前岗位」）
 * 会忽略缓存重新取数 —— 否则一旦内存里是旧的/占位的岗位，面板没有任何纠正手段。
 *
 * 取数顺序：按 URL 上的 securityId 主动补一次请求 → DOM 兜底读 JD（带上 DOM 里的岗位名/公司名）。
 * 冷却窗口只是为了不让「岗位已下架」这类失败被反复重发。
 */
async function resolveCurrentJob(force = false): Promise<void> {
  if (currentJob.value && !force)
    return

  const securityId = securityIdFromUrl(window.location.href)
  const shouldFetch = securityId.length > 0 && (
    lastFetch?.securityId !== securityId
    || (force && Date.now() - lastFetch.at > REFETCH_COOLDOWN_MS)
  )

  if (shouldFetch) {
    lastFetch = { securityId, at: Date.now() }
    try {
      const view = await fetchJobView(securityId)
      if (view) {
        currentJob.value = view
        return
      }
    }
    catch (error) {
      console.warn('[offer-hunter] 主动拉取岗位详情失败，退回 DOM 兜底', error)
    }
  }

  // DOM 兜底：文本没变就不重建（避免把接口数据的 source 降级成 dom）
  const jd = readJdFromDom()
  if (!jd || jd === currentJob.value?.jdText)
    return

  const base = currentJob.value?.securityId === securityId
    ? currentJob.value
    : (securityId ? { securityId } : null)

  currentJob.value = buildDomFallbackJob(jd, base, readJobOutlineFromDom())
}

onMessage('request-current-job', async ({ data }) => {
  await resolveCurrentJob(Boolean(data?.force))
  return { job: currentJob.value, url: window.location.href }
})

/**
 * 收集诊断信息。
 *
 * 刻意抽成独立函数：把这段逻辑内联在 onMessage 回调里会让 TypeScript 在
 * 推导回调类型时退化（表现为 "This expression is not callable"）。
 */
async function collectDiagnostic(): Promise<DiagnosticResult> {
  const job = currentJob.value

  const result: DiagnosticResult = {
    url: window.location.href,
    capturedApis: capturedApis.map(a => ({
      url: a.url,
      ok: a.ok,
      keys: a.keys,
      error: a.error,
    })),
    hasCurrentJob: job !== null,
    currentJobName: job?.jobName ?? null,
    currentJobSource: job?.source ?? null,
    jdLength: job?.jdText.length ?? 0,
    detailProbe: null,
    selectors: [],
  }

  // 详情接口探针：验证 securityId 契约是否仍然成立
  if (job?.securityId) {
    try {
      const detail = await fetchJobDetail(job.securityId)
      result.detailProbe = {
        securityId: job.securityId,
        ok: true,
        hasPostDescription: detail.jdText.length > 0,
        jdPreview: detail.jdText.slice(0, 120),
      }
    }
    catch (error) {
      result.detailProbe = {
        securityId: job.securityId,
        ok: false,
        hasPostDescription: false,
        jdPreview: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const selectorList: Array<[string, string]> = [
    ['详情 JD', JOB_DETAIL_DESC],
    ['详情容器', JOB_DETAIL_BOX],
    ...JOB_TITLE_SELECTORS.map((s, i): [string, string] => [`岗位名候选 ${i + 1}`, s]),
    ...JOB_COMPANY_SELECTORS.map((s, i): [string, string] => [`公司名候选 ${i + 1}`, s]),
  ]

  result.selectors = selectorList.map(([key, selector]) => {
    let count = 0
    try {
      count = document.querySelectorAll(selector).length
    }
    catch {
      count = 0
    }
    return { key, selector, found: count > 0, count }
  })

  const jd = readJdFromDom()
  if (jd) {
    result.selectors.push({
      key: '详情面板当前 JD',
      selector: '（已读取到文本）',
      found: true,
      count: jd.length,
    })
  }

  // DOM 兜底能读到的岗位标识：真机复验这两个关键词选择器是否还有效
  result.domOutline = readJobOutlineFromDom()

  return result
}

async function onRunDiagnostic(): Promise<DiagnosticResult> {
  return await collectDiagnostic()
}

onMessage('run-diagnostic', onRunDiagnostic)

console.info('[offer-hunter] 内容脚本已注入')
