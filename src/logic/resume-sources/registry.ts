import type { ResumeSourceAdapter, ResumeSourceId } from './types'
import { gistSource } from './gist'
import { pasteSource } from './paste'

/**
 * 简历来源注册表。
 *
 * **新增一个来源 = 加一个适配器文件 + 在下面加一行。**
 * Options.vue（下拉框）、background（消息路由）都从这里读，
 * 因此都不需要改 —— 这正是这次重构要买的性质。
 *
 * ⚠ 本文件会被**后台**（service worker）导入来做消息路由，所以绝不能在这里
 * 或它导入的模块里引用 Vue 组件：那会把编辑器级的依赖拖进后台包。
 * 自定义 UI 组件走 components/resume-sources 的查找表（只有设置页会读）。
 *
 * 数组顺序即设置页下拉框的展示顺序。
 */
export const RESUME_SOURCES: ResumeSourceAdapter[] = [
  pasteSource,
  gistSource,
]

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
 */
export function normalizeResumeSource(value: unknown): ResumeSourceId {
  const id = typeof value === 'string' ? value : ''
  return getResumeSource(id) ? (id as ResumeSourceId) : 'paste'
}

export type { ResumeSourceAdapter, ResumeSourceId } from './types'
