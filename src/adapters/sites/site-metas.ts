import type { SiteMeta } from './types'

/**
 * 一个 glob 结果：路径 → 模块（只要求有默认导出）。
 *
 * Vite 的 `import.meta.glob(..., { eager: true })` 与构建脚本自己扫目录得到的东西
 * 形状一致，因此站点描述的**聚合逻辑**只有这一份实现（见 buildSiteMetas）。
 */
export type SiteMetaModules = Record<string, { default: SiteMeta }>

/**
 * 把「目录约定扫出来的 meta 模块」聚合成站点描述列表。
 *
 * 单独抽出来的原因：**平台侧与构建脚本侧都要这份列表，但它们的 glob 机制不同**
 *  —— Vite 里是 `import.meta.glob`，而 scripts/ 跑在 Node 里（没有 Vite 的编译期
 *  特性，`import.meta.glob` 会直接报 "glob is not a function"）。
 *  两边各自实现一遍排序与取值，就会出现「终端里生成的 manifest 与扩展里认的站点
 *  顺序不一致」这种极难查的偏差。
 *
 * 顺序按路径排序：稳定、且不依赖文件系统的返回顺序（侧边栏按钮与诊断列表都用它）。
 */
export function buildSiteMetas(modules: SiteMetaModules): SiteMeta[] {
  return Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, mod]) => mod.default)
}
