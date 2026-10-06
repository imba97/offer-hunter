import type { Manifest } from 'webextension-polyfill'
import type PkgType from '../package.json'
import type { SiteMeta } from './adapters/sites/types'
import { readFile } from 'node:fs/promises'
import { isDev, isFirefox, port, r } from '../scripts/utils'

/**
 * 从站点描述生成 content_scripts。
 *
 * 有接口的站点（`source: 'api'`）两份脚本，顺序有讲究：
 *  1. MAIN world：运行在页面自身上下文，hook 页面的 fetch/XHR 被动捕获接口数据。
 *     **必须排在隔离世界脚本之前**，否则会漏掉页面首屏发出的请求。world 需要 Chrome 111+。
 *  2. ISOLATED world：只做「与页面打交道」的事。界面全部在侧边栏（扩展页面），
 *     因为需要页面 Cookie 的接口只能由内容脚本代侧边栏发起。
 *
 * 只读 DOM 的站点（`source: 'dom'`，如电鸭社区）**只有第二份**：它们没有任何接口
 * 需要捕获，注入 MAIN 脚本等于给宿主页面白挂一层 fetch/XHR 包装。
 *
 * 每个站点单独打包（sites/<id>/injected.ts 与 sites/<id>/content.ts），
 * 因此新增站点只是多一组条目，不会改动既有站点的产物 —— 而且**本文件也不用改**：
 * 站点清单由调用方按目录约定扫出来（见 scripts/site-descriptors.ts）。
 *
 * ⚠ 产物路径的命名约定必须与 vite.config.content.mts / vite.config.injected.mts
 *   一致（`<id>.global.js` / `<id>.js`），且站点 id 必须等于目录名。
 *   对不上会表现成「构建成功但脚本没注入」——src/__tests__/manifest.spec.ts 钉住了它。
 */
function siteContentScripts(descriptors: SiteMeta[]): Manifest.WebExtensionManifest['content_scripts'] {
  return descriptors.flatMap((site) => {
    const isolated = {
      matches: site.matches,
      js: [`dist/contentScripts/${site.id}.global.js`],
      run_at: 'document_idle' as const,
    }

    if (site.source !== 'api')
      return [isolated]

    return [
      {
        matches: site.matches,
        js: [`dist/injected/${site.id}.js`],
        run_at: 'document_start' as const,
        world: 'MAIN' as const,
      },
      isolated,
    ]
  })
}

/**
 * 生成 manifest。
 *
 * `descriptors` 由调用方传入（而不是在这里 glob）是为了让它**既能在 Node 里跑
 * 也能在测试里跑**：Node 里没有 Vite 的 `import.meta.glob`（见
 * scripts/site-descriptors.ts），而测试里可以自己 glob 一份，两边都不必改本文件。
 */
export async function getManifest(descriptors: SiteMeta[]) {
  const pkg = JSON.parse(await readFile(r('package.json'), 'utf-8')) as typeof PkgType

  // update this file to update this manifest.json
  // can also be conditional based on your need
  const manifest: Manifest.WebExtensionManifest = {
    manifest_version: 3,
    name: pkg.displayName || pkg.name,
    version: pkg.version,
    description: pkg.description,
    action: {
      default_icon: 'assets/icon-512.png',
      default_title: 'Offer Hunter',
      // 刻意不设 default_popup：一旦设置，action.onClicked 就不会触发，
      // 而我们需要在点击时判断当前标签页是否在支持的招聘网站，决定
      // 「开合侧边栏」还是「跳转职位页」。
    },
    options_ui: {
      page: 'dist/options/index.html',
      open_in_tab: true,
    },
    background: {
      /*
       * 两个浏览器要的是**不同的键**，而且各自只认自己那个：
       *
       *  - Chrome（MV3）：只认 `service_worker`。多出来的 `scripts` 是 MV2 的键，
       *    Chrome 会直接在扩展页报「'background.scripts' requires manifest
       *    version of 2 or lower」——它不会因此挂掉，但每装一次都留一条噪音警告，
       *    而扩展页是用户排障时第一眼看的地方，不该有假警报。
       *  - Firefox：走 `scripts` + `type: module`（见下面的历史注释）。
       *
       * 因此这里按浏览器分支**互斥**地给键，而不是两个都写上「以兼容两边」。
       * src/__tests__/manifest.spec.ts 钉住了这条：Chrome 产物里不许出现 scripts。
       *
       * 历史：Firefox 109-120 有 bug：只要存在 service_worker，后台就起不来，
       * 所以 Firefox 分支反而要把它摘掉。见 https://mzl.la/4r6SF1L 与
       * Firefox bug 1860304。
       */
      ...(isFirefox
        ? { scripts: ['dist/background/index.mjs'], type: 'module' as const }
        : { service_worker: 'dist/background/index.mjs' }),
    },
    browser_specific_settings: {
      gecko: {
        id: '{069e1c5a-1cd1-44ae-9b11-7091626a9eb6}',
        strict_min_version: '109.0',
        // 声明扩展是否收集/传输用户数据，供 AMO 审核用
        // none = 不收集任何数据
        // see https://mzl.la/firefox-builtin-data-consent
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
    icons: {
      16: 'assets/icon-16.png',
      32: 'assets/icon-32.png',
      48: 'assets/icon-48.png',
      128: 'assets/icon-128.png',
    },
    permissions: [
      'tabs',
      /*
       * TODO(过渡代码)：`storage` 只为读取旧版本遗留的 chrome.storage.local 数据
       * （一次性迁移）而保留，见 docs/transitional-code.md。
       * 迁移在真实用户中验证过一两个版本后，应单独发一版移除它 ——
       * 日常读写走扩展自己的 IndexedDB，不需要任何权限（决策 C）。
       */
      'storage',
      'activeTab',
      // 侧边栏是主要交互界面（浏览器原生，不存在遮挡与定位问题）
      'sidePanel',
    ],
    // 主机权限由站点描述生成：只申请各站点自己声明的那几个域名，
    // 而不是「所有网站」。加站点时这里是自动的。
    host_permissions: descriptors.flatMap(site => site.matches),
    content_scripts: siteContentScripts(descriptors),
    // 刻意不声明 web_accessible_resources：内容脚本不再渲染任何界面资源
    // （界面全在侧边栏），没有需要暴露给页面的文件，少一处可被页面探测的指纹。
    content_security_policy: {
      extension_pages: isDev
        // this is required on dev for Vite script to load
        ? `script-src \'self\' http://localhost:${port}; object-src \'self\'`
        : 'script-src \'self\'; object-src \'self\'',
    },
  }

  // 侧边栏：Chrome 用 side_panel，Firefox 用 sidebar_action
  if (isFirefox) {
    manifest.sidebar_action = {
      default_panel: 'dist/sidepanel/index.html',
    }
  }
  else {
    (manifest as any).side_panel = {
      default_path: 'dist/sidepanel/index.html',
    }
  }

  // FIXME: not work in MV3
  if (isDev && false) {
    // for content script, as browsers will cache them for each reload,
    // we use a background script to always inject the latest version
    // see src/background/contentScriptHMR.ts
    delete manifest.content_scripts
    manifest.permissions?.push('webNavigation')
  }

  return manifest
}
