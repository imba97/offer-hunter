import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { build } from 'vite'
import { isDev, log, r } from './utils'

/**
 * 按站点逐个打包内容脚本与注入脚本。
 *
 * 为什么不直接在 vite 配置里写多个入口：manifest 的 `js` 数组按普通脚本注入，
 * 因此产物必须是 IIFE，而 Vite 8 明确不支持「多入口 + iife/umd」——
 * 会报 "Multiple entry points are not supported when output formats include umd or iife"。
 * 于是循环搬到这里：每个站点各跑一次配置，产物互相独立。
 *
 * 站点清单用**目录约定**发现（src/sites/<id>/ 下有 content.ts 就算一个站点），
 * 与 sites/registry.ts 的注册项保持一致 —— 加一个站点目录 + 注册一行。
 *
 * 用法：
 *   esno scripts/build-sites.ts content
 *   esno scripts/build-sites.ts injected
 */

type Target = 'content' | 'injected'

const SITES_DIR = r('src/sites')

/** 与 sites/registry.ts 同一套约定：目录 + 该目标对应的入口文件 */
function discoverSites(target: Target): string[] {
  const entryName = target === 'content' ? 'content.ts' : 'injected.ts'

  const ids = readdirSync(SITES_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    // 排除 __tests__ 之类的非站点目录，避免把它们也当成站点
    .filter(entry => !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .filter(id => existsSync(resolve(SITES_DIR, id, entryName)))

  if (ids.length === 0)
    throw new Error(`src/sites/ 下没有找到任何含 ${entryName} 的站点目录`)

  return ids
}

async function main(): Promise<void> {
  const target = process.argv[2] as Target | undefined
  if (target !== 'content' && target !== 'injected') {
    throw new Error(`用法：esno scripts/build-sites.ts <content|injected>，收到：${target ?? '(空)'}`)
  }

  const configFile = target === 'content' ? 'vite.config.content.mts' : 'vite.config.injected.mts'
  const sites = discoverSites(target)

  log('BUILD', `${target}：${sites.join(', ')}`)

  for (const site of sites) {
    /*
     * 逐个站点调用 Vite 的 JS API。
     *
     * 必须串行 await：并行时两个构建会同时读写同一个 outDir，而且都拿
     * 同一份 vite 缓存目录，实测会互相覆盖产物。
     * 站点数量是个位数，串行的代价可以忽略。
     *
     * ⚠ 站点必须经 **process.env** 传给配置文件，不能用 build({ env })：
     *   后者只影响 import.meta.env 的替换，而配置文件是在 Vite 的
     *   configLoader 里读取的，它只认真正的进程环境变量（踩过：
     *   配置里读到空值，直接抛「缺少 OFFER_HUNTER_SITE」）。
     */
    process.env.OFFER_HUNTER_SITE = site

    await build({
      configFile: r(configFile),
      mode: isDev ? 'development' : 'production',
    })
  }

  delete process.env.OFFER_HUNTER_SITE
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
