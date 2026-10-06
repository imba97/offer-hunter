import type { InjectedEntry } from './injected-protocol'
import type { ApiJobSiteAdapter, JobSiteAdapter } from './types'
import type { DiagnosticResult, JobView } from '~/logic/types'
import { jobIdentity, recordKey } from '~/logic/types'

/**
 * 诊断信息的组装。
 *
 * 「页面改版了没」这个问题只能靠真机复验：站点贡献自己的选择器命中情况
 * （`site.diagnose()`），通用部分（捕获记录、详情接口契约探针、当前岗位的账本键）
 * 在这里拼起来，一起交给侧边栏的诊断面板。
 *
 * ⚠ 刻意从内容脚本里抽出来，除了「一个文件别管四件事」之外还有个实际原因：
 *   这段逻辑内联在 `onMessage` 回调里会让 TypeScript 推导回调类型时退化
 *   （表现为 "This expression is not callable"）。
 *
 * 与内容脚本的其余部分一样，**允许直接碰 DOM**：诊断本来就是读页面现状。
 */

export interface DiagnosticInput {
  site: JobSiteAdapter
  /** 收窄后的接口站点；DOM-only 站点为 null（没有接口契约可验） */
  apiSite: ApiJobSiteAdapter | null
  /** 当前岗位，null 表示用户还没点开任何岗位 */
  job: JobView | null
  /** 本会话捕获到的接口记录 */
  capturedApis: InjectedEntry[]
}

export async function collectDiagnostic(input: DiagnosticInput): Promise<DiagnosticResult> {
  const { site, apiSite, job, capturedApis } = input
  const siteDiag = site.diagnose()

  const result: DiagnosticResult = {
    url: window.location.href,
    capturedApis: capturedApis.map(a => ({
      url: a.url,
      ok: a.ok,
      keys: a.keys,
      error: a.error,
    })),
    hasCurrentJob: job !== null,
    currentJobName: job?.job.title ?? null,
    currentJobSource: job?.source ?? null,
    // 面板就是按这个键查分析结果的：它长什么样，直接决定面板能不能显示出来
    currentJobKey: job ? recordKey(jobIdentity(job)) : null,
    jdLength: job?.jdText.length ?? 0,
    detailProbe: null,
    selectors: [],
  }

  // 详情接口探针：验证「标识 → JD」这条契约是否仍然成立
  // （DOM-only 站点没有接口契约可验，探针保持 null，面板据此换一段说明）
  const naturalKey = job?.site.naturalKey ?? ''
  if (apiSite && naturalKey) {
    try {
      const probe = await apiSite.probeDetail(naturalKey)
      result.detailProbe = {
        naturalKey,
        ok: true,
        hasPostDescription: probe.hasDescription,
        jdPreview: probe.preview,
      }
    }
    catch (error) {
      result.detailProbe = {
        naturalKey,
        ok: false,
        hasPostDescription: false,
        jdPreview: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  result.selectors = siteDiag.selectors.map((probe) => {
    let count = 0
    try {
      count = document.querySelectorAll(probe.selector).length
    }
    catch {
      count = 0
    }
    // 逐字透传站点的探针（含 key 与 label），只补命中情况
    return { ...probe, found: count > 0, count }
  })

  const jd = site.readJd()
  if (jd) {
    result.selectors.push({
      key: 'currentJd',
      label: '详情面板当前 JD',
      selector: '（已读取到文本）',
      found: true,
      count: jd.length,
    })
  }

  // DOM 兜底能读到的岗位标识：真机复验关键词选择器是否还有效
  result.domOutline = siteDiag.domOutline

  return result
}
