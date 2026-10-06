import type { ResumeSourceAdapter, ResumeSourceId } from './types'

/**
 * 简历来源注册表。
 *
 * **新增一个来源 = 加一个 `adapters/resume-sources/<id>/` 目录（`index.ts` 里默认导出
 * `defineResumeSource(...)`），然后什么都不用改** —— 本文件按目录约定 glob 它们。
 * Options.vue（下拉框）、background（消息路由）、存储迁移都从这里读。
 *
 * ⚠ 本文件会被**后台**（service worker）导入来做消息路由，所以绝不能在这里
 * 或它导入的模块里引用 Vue 组件：那会把编辑器级的依赖拖进后台包。
 * 自定义 UI 组件走 components/resume-sources 的查找表（只有设置页会读）。
 *
 * 数组顺序即设置页下拉框的展示顺序：**手动编辑固定第一**（它是默认值、也是绝大多数
 * 人的起点），其余按目录路径排序（稳定，且不依赖文件系统的返回顺序）。
 */
export const RESUME_SOURCES: ResumeSourceAdapter[] = (() => {
  const all = Object.entries(
    import.meta.glob<{ default: ResumeSourceAdapter }>('./*/index.ts', { eager: true }),
  )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, mod]) => mod.default)

  const local = all.filter(source => source.contentSource === 'local')
  const remote = all.filter(source => source.contentSource !== 'local')
  return [...local, ...remote]
})()

/** 按 id 取适配器；未知 id 返回 undefined（存储里可能残留已废弃的来源） */
export function getResumeSource(id: string): ResumeSourceAdapter | undefined {
  return RESUME_SOURCES.find(source => source.id === id)
}

/** 下拉框选项 */
export function resumeSourceOptions(): Array<{ value: ResumeSourceId, label: string, hint: string }> {
  return RESUME_SOURCES.map(source => ({
    value: source.id,
    label: source.label,
    hint: source.hint,
  }))
}

/**
 * 把存储里的来源收敛成当前支持的某一种。
 *
 * 存储里可能是 null（早于来源概念的旧数据）、也可能残留已废弃的值，
 * 这些一律按「手动输入」处理 —— 那正是它们原本的行为。
 *
 * ⚠ 兜底的那个 id 必须真的存在于注册表里（`paste/`）：写错的话用户的历史配置会
 *   被静默指到一个不存在的来源上，界面表现为「来源面板是空的」。
 */
const FALLBACK_SOURCE_ID: ResumeSourceId = 'paste'

export function normalizeResumeSource(value: unknown): ResumeSourceId {
  const id = typeof value === 'string' ? value : ''
  return getResumeSource(id) ? id : FALLBACK_SOURCE_ID
}

export type { ResumeSourceAdapter, ResumeSourceId } from './types'
