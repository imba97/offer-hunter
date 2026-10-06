import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'vite'
import { isDev, r } from './scripts/utils'
import { sharedConfig } from './vite.config.mjs'

/**
 * 内容脚本（ISOLATED world）打包 —— **每次只打一个站点**。
 *
 * 站点与入口由环境变量给出（`OFFER_HUNTER_SITE` / `OFFER_HUNTER_SITE_ENTRY`）；
 * scripts/build-sites.ts 会为每个站点各跑一次本配置。为什么要这样绕：
 *
 *   manifest 的 `js` 数组是按普通脚本注入的，所以产物必须是 **IIFE**，
 *   而 Vite 8 明确不支持「多个入口 + iife/umd」（报 "Multiple entry points are
 *   not supported when output formats include umd or iife"）。
 *   umd 虽然允许多入口，但它没有代码分割，且会写入全局变量 —— 不必要。
 *   因此改成「一个站点一个配置实例」，循环交给构建脚本。
 *
 * 逐站点打包反而更贴合需求：各站点的选择器不会互相污染，新增站点也不改变
 * 既有站点的产物（避免「加一家、坏一家」）。
 *
 * ⚠ 入口路径由构建脚本给出，不在这里按目录拼：站点**可以嵌在平台目录下**
 *   （sites/feishu/mediastorm/content.ts），而站点 id 仍然只是叶子目录名
 *   （见 scripts/build-sites.ts 的 discoverSites）。
 *
 * ⚠ 站点清单用**目录约定**发现，而不是 import sites/registry —— 那个注册表用了
 *   `~/` 别名，而 Vite 读配置文件时走自己的打包路径，解析不了别名
 *   （实测 ERR_MODULE_NOT_FOUND）。约定与注册表一致：加一个站点目录 + 注册一行。
 */
const targetSite = process.env.OFFER_HUNTER_SITE ?? ''
const targetEntry = process.env.OFFER_HUNTER_SITE_ENTRY ?? ''

if (!targetSite || !targetEntry) {
  throw new Error(
    '缺少 OFFER_HUNTER_SITE / OFFER_HUNTER_SITE_ENTRY：内容脚本必须按站点逐个构建，请用 `pnpm build:js`（见 scripts/build-sites.ts）',
  )
}

const entry = resolve(targetEntry)
if (!existsSync(entry)) {
  throw new Error(`站点 ${targetSite} 的内容脚本入口不存在：${entry}`)
}

export default defineConfig({
  ...sharedConfig,
  define: {
    '__DEV__': isDev,
    '__NAME__': JSON.stringify('offer-hunter-content'),
    // https://github.com/vitejs/vite/issues/9320
    // https://github.com/vitejs/vite/issues/9186
    'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
  },
  build: {
    /*
     * watch 刻意不在这里开：dev 由 scripts/build-sites.ts 的 `--watch` 参数逐站点打开
     * （见那个文件：这里开了的话，就没法「一个站点构建完再打下一个」，
     * 而站点必须串行——它们共用同一个 OFFER_HUNTER_SITE 环境变量与 outDir）。
     */
    outDir: r('extension/dist/contentScripts'),
    cssCodeSplit: false,
    emptyOutDir: false,
    sourcemap: isDev ? 'inline' : false,
    rollupOptions: {
      input: entry,
      output: {
        // IIFE：内容脚本不能是 ESM（manifest 的 js 数组按普通脚本注入）
        format: 'iife',
        entryFileNames: `${targetSite}.global.js`,
        // 入口没有任何导出，别往全局挂东西
        exports: 'none',
      },
    },
  },
})
