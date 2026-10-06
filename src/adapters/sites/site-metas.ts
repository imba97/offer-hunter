import type { AdapterModules } from '../collect'
import type { SiteMeta } from './types'
import { collectAdapters } from '../collect'

/**
 * 站点描述的聚合入口。
 *
 * 实现已收敛到 `adapters/collect.ts`（站点 / AI 平台 / 简历来源三处共用）。这个文件
 * 保留下来是因为站点侧多一层理由：**构建脚本（Node）也要同一份列表**，而那里没有
 * Vite 的 `import.meta.glob` —— 两边交给同一个函数加工，顺序才不会分叉
 * （见 scripts/site-descriptors.ts）。
 */

/** 一个 glob 结果：路径 → 模块（只要求有默认导出） */
export type SiteMetaModules = AdapterModules<SiteMeta>

export function buildSiteMetas(modules: SiteMetaModules): SiteMeta[] {
  return collectAdapters(modules)
}
