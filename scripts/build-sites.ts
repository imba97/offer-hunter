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
 * 只读 DOM 的站点没有 injected.ts，因此内容脚本这一趟会发现它、注入脚本那一趟不会。
 *
 * 用法：
 *   esno scripts/build-sites.ts content
 *   esno scripts/build-sites.ts injected
 *   esno scripts/build-sites.ts content --watch   （dev：每个站点各起一个 watcher）
 */

type Target = 'content' | 'injected'

const SITES_DIR = r('src/sites')

/**
 * 站点 id → 入口文件绝对路径（该目标对应的那个入口）。
 *
 * ⚠ 站点**可以嵌在平台目录下**（`sites/feishu/mediastorm/content.ts`）：
 *   飞书招聘这类「一套前端 + 一套接口 + 多家公司子域」的平台，平台共用逻辑放在
 *   `sites/<平台>/`，每家公司是它下面的一个子目录。因此这里**按叶子目录名取站点
 *   id**（`mediastorm`），并递归一层去找入口 —— 站点 id 仍然等于它自己那个目录名，
 *   「id 与目录名一致」这条约定没有被破坏（见 src/sites/types.ts 与
 *   src/sites/__tests__/registry.spec.ts）。
 *
 * 之所以只递归一层而不是任意深度：`sites/<平台>/<站点>/` 已经够表达「平台 + 租户」，
 * 再深就该重新想抽象了 —— 而那种结构下「站点 id 取自哪个目录」会变得含糊。
 */
function discoverSites(target: Target): Map<string, string> {
  const entryName = target === 'content' ? 'content.ts' : 'injected.ts'
  const found = new Map<string, string>()

  const collect = (dir: string, id: string): void => {
    const entry = resolve(dir, entryName)
    if (existsSync(entry)) {
      found.set(id, entry)
      return
    }

    for (const child of readdirSync(dir, { withFileTypes: true })) {
      // 排除 __tests__ 之类的非站点目录，避免把它们也当成站点
      if (!child.isDirectory() || child.name.startsWith('_') || child.name.startsWith('.'))
        continue
      collect(resolve(dir, child.name), child.name)
    }
  }

  for (const child of readdirSync(SITES_DIR, { withFileTypes: true })) {
    if (!child.isDirectory() || child.name.startsWith('_') || child.name.startsWith('.'))
      continue
    collect(resolve(SITES_DIR, child.name), child.name)
  }

  if (found.size === 0)
    throw new Error(`src/sites/ 下没有找到任何含 ${entryName} 的站点目录`)

  return found
}

async function main(): Promise<void> {
  const target = process.argv[2] as Target | undefined
  if (target !== 'content' && target !== 'injected') {
    throw new Error(`用法：esno scripts/build-sites.ts <content|injected> [--watch]，收到：${target ?? '(空)'}`)
  }

  /*
   * watch 由这里的参数开启，而不是写在 vite 配置里：配置里开了 watch 就没法
   * 「await 完一个站点再打下一个」（watch 模式下构建不会结束），
   * 而站点少、串行构建的代价可以忽略。
   */
  const watch = process.argv.includes('--watch')

  const configFile = target === 'content' ? 'vite.config.content.mts' : 'vite.config.injected.mts'
  const sites = discoverSites(target)

  log('BUILD', `${target}：${[...sites.keys()].join(', ')}${watch ? '（watch）' : ''}`)

  /*
   * ⚠ 站点必须经 **process.env** 传给配置文件，不能用 build({ env })：
   *   后者只影响 import.meta.env 的替换，而配置文件是在 Vite 的
   *   configLoader 里读取的，它只认真正的进程环境变量（踩过：
   *   配置里读到空值，直接抛「缺少 OFFER_HUNTER_SITE」）。
   *
   * ⚠ 因此这里**必须串行**，不能先把所有站点都 map 成 promise：
   *   那样每个 async 函数会在第一个 await 之前同步跑完「写环境变量」这一步，
   *   于是所有构建读到的都是最后一个站点的 id（产物全跑到同一个站点名下）。
   *
   * 串行的另一个理由：并行时两个构建会同时读写同一个 outDir，而且都拿
   * 同一份 vite 缓存目录，实测会互相覆盖产物。站点数量是个位数，代价可忽略。
   *
   * watch 模式下每个站点自己的 watcher 会活到进程结束：`build()` 在首个构建
   * 完成后 resolve（返回 watcher），所以循环能继续走到下一个站点。
   */
  for (const [site, entry] of sites) {
    /*
     * ⚠ 站点 id 经**环境变量**传给配置，入口路径经另一个变量传：
     *   站点可以嵌在平台目录下（sites/feishu/mediastorm/），配置里无法靠
     *   `sites/<id>/content.ts` 拼出入口，而它又必须知道产物该叫什么名字。
     */
    process.env.OFFER_HUNTER_SITE = site
    process.env.OFFER_HUNTER_SITE_ENTRY = entry
    await build({
      configFile: r(configFile),
      mode: isDev ? 'development' : 'production',
      build: watch ? { watch: {} } : undefined,
    })
  }

  if (watch) {
    // 不删环境变量：每个 watcher 重新构建时配置会被重新求值，删了它会抛「缺少 OFFER_HUNTER_SITE」
    return
  }

  delete process.env.OFFER_HUNTER_SITE
  delete process.env.OFFER_HUNTER_SITE_ENTRY
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
