import type { ProtocolWithReturn } from 'webext-bridge'
import type {
  DiagnosticResult,
  JobRecord,
  JobSummary,
  JobView,
  MatchResult,
} from '~/logic/types'

/**
 * webext-bridge 的类型安全消息协议。
 *
 * 三个运行上下文：
 *   侧边栏（sidepanel）—— 全部界面
 *   后台（background）—— AI 调用、账本、图标点击、请求转发
 *   内容脚本（content）—— 只有它能在 BOSS 页面上发 /wapi/ 请求
 *
 * ★ 关键约束：`/wapi/` 接口必须携带页面 Cookie，而侧边栏与后台都发不出这种请求，
 * 因此**所有接口调用都要经由内容脚本**。转发由后台统一负责
 * （见 background/main.ts 的 relay 部分）。
 *
 * ⚠ 无数据的消息用 `Record<string, never>`（空对象）而不是 `undefined`：
 * webext-bridge 的泛型受 JsonValue 约束，undefined 不是合法 JSON 值，
 * 写它会令 onMessage 的推断整体退化。
 */
declare module 'webext-bridge' {
  export interface ProtocolMap {
    // ---- [内容脚本] 处理：与 BOSS 页面打交道（只读） ----
    /** 读取当前打开的岗位（含 JD）；force 用于面板上的「刷新当前岗位」强制纠正 */
    'request-current-job': ProtocolWithReturn<
      { force?: boolean },
      { job: JobView | null, url: string }
    >
    /** 运行真机诊断 */
    'run-diagnostic': ProtocolWithReturn<Record<string, never>, DiagnosticResult>

    // ---- [内容脚本] 发出：主动通知侧边栏岗位变了 ----
    /**
     * 岗位变化推送。
     *
     * 侧边栏拿不到页面访问权，之前只能每 2 秒轮询一次；有了这条推送，
     * 轮询降为兜底。没有侧边栏在监听时会失败，属正常情况。
     */
    'job-changed': ProtocolWithReturn<{ job: JobView | null }, void>

    // ---- [后台] 处理 ----
    /** AI 连通性测试 */
    'ai-test': ProtocolWithReturn<
      Record<string, never>,
      {
        ok: boolean
        provider?: string
        model?: string
        baseUrl?: string
        reply?: string
        error?: string
        latencyMs?: number
      }
    >
    /** AI 匹配度分析 */
    'ai-match': ProtocolWithReturn<
      { job: JobSummary, jdText: string },
      { ok: true, data: MatchResult } | { ok: false, error: string }
    >
    /** 生成打招呼语 */
    'ai-greeting': ProtocolWithReturn<
      { job: JobSummary, jdText: string, match?: MatchResult | null },
      { ok: true, data: { greeting: string, rationale: string } } | { ok: false, error: string }
    >
    /** 读取整个账本 */
    'get-records': ProtocolWithReturn<Record<string, never>, Record<string, JobRecord>>
    /** 写入/更新一条岗位记录 */
    'upsert-record': ProtocolWithReturn<JobRecord, { ok: boolean }>

    // ---- [后台] 转发：把侧边栏的请求转给当前标签页的内容脚本 ----
    /** 转发：读取当前岗位（force = 忽略缓存，强制重新取数） */
    'relay-current-job': ProtocolWithReturn<
      { force?: boolean },
      { ok: boolean, job?: JobView | null, reason?: string }
    >
    /** 转发：诊断 */
    'relay-diagnostic': ProtocolWithReturn<
      Record<string, never>,
      { ok: boolean, result?: DiagnosticResult, reason?: string }
    >
  }
}
