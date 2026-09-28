import type { Manifest } from 'webextension-polyfill'
import type PkgType from '../package.json'
import { readFile } from 'node:fs/promises'
import { isDev, isFirefox, port, r } from '../scripts/utils'
import { SITE_DESCRIPTORS, siteMatches } from './sites/routing'

/**
 * 从站点描述生成 content_scripts。
 *
 * 每个站点两份脚本（顺序有讲究）：
 *  1. MAIN world：运行在页面自身上下文，hook 页面的 fetch/XHR 被动捕获接口数据。
 *     **必须排在隔离世界脚本之前**，否则会漏掉页面首屏发出的请求。world 需要 Chrome 111+。
 *  2. ISOLATED world：只做「与页面打交道」的事。界面全部在侧边栏（扩展页面），
 *     因为需要页面 Cookie 的接口只能由内容脚本代侧边栏发起。
 *
 * 每个站点单独打包（sites/<id>/injected.ts 与 sites/<id>/content.ts），
 * 因此新增站点只是多一组条目，不会改动既有站点的产物。
 *
 * ⚠ 产物路径的命名约定必须与 vite.config.content.mts / vite.config.injected.mts
 *   一致（`<id>.global.js` / `<id>.js`），且站点 id 必须等于目录名。
 *   对不上会表现成「构建成功但脚本没注入」——src/__tests__/manifest.spec.ts 钉住了它。
 */
function siteContentScripts(): Manifest.WebExtensionManifest['content_scripts'] {
  return SITE_DESCRIPTORS.flatMap(site => [
    {
      matches: site.matches,
      js: [`dist/injected/${site.id}.js`],
      run_at: 'document_start' as const,
      world: 'MAIN' as const,
    },
    {
      matches: site.matches,
      js: [`dist/contentScripts/${site.id}.global.js`],
      run_at: 'document_idle' as const,
    },
  ])
}

export async function getManifest() {
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
    background: isFirefox
      ? {
          scripts: ['dist/background/index.mjs'],
          type: 'module',
        }
      : {
          service_worker: 'dist/background/index.mjs',
        },
    icons: {
      16: 'assets/icon-16.png',
      32: 'assets/icon-32.png',
      48: 'assets/icon-48.png',
      128: 'assets/icon-128.png',
    },
    permissions: [
      'tabs',
      'storage',
      'activeTab',
      // 侧边栏是主要交互界面（浏览器原生，不存在遮挡与定位问题）
      'sidePanel',
    ],
    // 主机权限由注册表生成：只申请各站点适配器声明的那几个域名，
    // 而不是「所有网站」。加站点时这里是自动的。
    host_permissions: siteMatches(),
    content_scripts: siteContentScripts(),
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
