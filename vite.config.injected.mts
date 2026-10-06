import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'vite'
import { isDev, r } from './scripts/utils'
import { sharedConfig } from './vite.config.mjs'

/**
 * MAIN world 注入脚本打包 —— **每次只打一个站点**。
 *
 * 站点与入口由环境变量给出（`OFFER_HUNTER_SITE` / `OFFER_HUNTER_SITE_ENTRY`）；
 * scripts/build-sites.ts 会为每个站点各跑一次本配置（与 vite.config.content.mts
 * 同一套做法，理由见那个文件：Vite 8 不支持多入口 + iife）。
 *
 * 必须打成**自包含 IIFE**：manifest 里 world:MAIN 的注入只接受普通脚本，
 * 不支持 ESM import，所以每个站点的产物必须把所有依赖内联进来。
 * 这也是它不能和内容脚本共用同一个 bundle 的原因。
 */
const targetSite = process.env.OFFER_HUNTER_SITE ?? ''
const targetEntry = process.env.OFFER_HUNTER_SITE_ENTRY ?? ''

if (!targetSite || !targetEntry) {
  throw new Error(
    '缺少 OFFER_HUNTER_SITE / OFFER_HUNTER_SITE_ENTRY：注入脚本必须按站点逐个构建，请用 `pnpm build:injected`（见 scripts/build-sites.ts）',
  )
}

const entry = resolve(targetEntry)
if (!existsSync(entry)) {
  throw new Error(`站点 ${targetSite} 的注入脚本入口不存在：${entry}`)
}

export default defineConfig({
  ...sharedConfig,
  define: {
    __DEV__: isDev,
    // 注入脚本不读 package.json 的 name，避免把包名暴露给页面
    __NAME__: JSON.stringify('offer-hunter-injected'),
  },
  plugins: [],
  build: {
    // watch 由 scripts/build-sites.ts 的 `--watch` 打开，理由见 vite.config.content.mts
    outDir: r('extension/dist/injected'),
    cssCodeSplit: false,
    emptyOutDir: false,
    sourcemap: isDev ? 'inline' : false,
    rollupOptions: {
      input: entry,
      output: {
        // 自包含 IIFE：MAIN world 注入不接受 ESM
        format: 'iife',
        entryFileNames: `${targetSite}.js`,
        exports: 'none',
      },
    },
  },
})
