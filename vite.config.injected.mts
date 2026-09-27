import { defineConfig } from 'vite'
import { sharedConfig } from './vite.config.mjs'
import { isDev, r } from './scripts/utils'

/**
 * MAIN world 注入脚本。
 *
 * 必须打包成自包含 IIFE：manifest 里 world:"MAIN" 的 content script 只接受
 * 普通脚本，不支持 ESM import，因此不能和内容脚本共用同一个 bundle。
 */
export default defineConfig({
  ...sharedConfig,
  define: {
    __DEV__: isDev,
    // 注入脚本不读 package.json 的 name，避免把包名暴露给页面
    __NAME__: JSON.stringify('offer-hunter-injected'),
  },
  plugins: [],
  build: {
    watch: isDev
      ? {}
      : undefined,
    outDir: r('extension/dist/injected'),
    cssCodeSplit: false,
    emptyOutDir: false,
    sourcemap: isDev ? 'inline' : false,
    lib: {
      entry: r('src/contentScripts/injected/index.ts'),
      name: '__offerHunterInjected',
      formats: ['iife'],
    },
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
        extend: true,
      },
    },
  },
})
