import type { SiteMeta } from './sites/types'

/**
 * 「按目录约定收集适配器」的共用实现。
 *
 * 插件里有**三处**同构的可扩展点：招聘站点（`adapters/sites`）、AI 平台
 * （`adapters/ai/platforms`）、简历来源（`adapters/resume-sources`）。它们的注册表
 * 都是同一件事：
 *
 *   1. `import.meta.glob` 扫出目录里的入口模块
 *   2. 按路径排序（顺序稳定，不依赖文件系统的返回顺序）
 *   3. 取出默认导出，拼成数组
 *   4. 可选：过滤掉不合形状的（平台目录本身不是站点之类）
 *
 * 此前这段在四处各写一遍（`site-metas.ts` 那份只服务站点）。抄第二遍的时候没人会
 * 记得「顺序必须稳定」这条约定，而它一旦丢失，症状是侧边栏按钮与诊断列表的**顺序
 * 在两次启动之间会变**——很难联想到是 glob 的锅。
 *
 * ⚠ 这个函数**不依赖 Vite 也不依赖运行时**：`import.meta.glob` 的调用留在各自的
 *   注册表里（那是编译期特性，必须写在会被 Vite 处理的文件中），这里只做纯数据加工。
 */

/** 一个 glob 结果：路径 → 模块（只要求有默认导出） */
export type AdapterModules<T> = Record<string, { default: T }>

export interface CollectAdaptersOptions<T> {
  /**
   * 过滤：返回 false 的条目被丢掉。
   *
   * 用在「目录里混着非适配器的东西」的场景（例如站点那棵树里平台目录本身不是站点）。
   * 不传即全收。
   */
  filter?: (adapter: T) => boolean
}

/**
 * 把 glob 结果收成适配器数组：排序 → 取默认导出 → 过滤。
 *
 * ⚠ 先排序再过滤（而不是反过来）：过滤的判据只涉及单个适配器，但排序必须建立在
 *   **路径**上才稳定，而过滤掉几项之后路径信息就没了。
 */
export function collectAdapters<T>(
  modules: AdapterModules<T>,
  options: CollectAdaptersOptions<T> = {},
): T[] {
  const all = Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, mod]) => mod.default)

  return options.filter ? all.filter(options.filter) : all
}

/**
 * 站点描述的聚合（`site-metas.ts` 的历史入口，保留名字以免调用方大改）。
 *
 * 站点侧多一层理由：**构建脚本（Node）也要同一份列表**，而那里没有 Vite 的
 * `import.meta.glob` —— 两边交给同一个函数加工，顺序才不会分叉
 * （见 scripts/site-descriptors.ts）。
 */
export function buildSiteMetas(modules: AdapterModules<SiteMeta>): SiteMeta[] {
  return collectAdapters(modules)
}
