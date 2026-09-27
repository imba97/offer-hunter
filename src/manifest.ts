import type { Manifest } from 'webextension-polyfill'
import type PkgType from '../package.json'
import { readFile } from 'node:fs/promises'
import { isDev, isFirefox, port, r } from '../scripts/utils'

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
      // 而我们需要在点击时判断当前标签页是否在 BOSS 页面，决定
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
    // Offer Hunter only ever runs on BOSS 直聘, so the extension asks for the
    // narrowest host access it needs instead of every site on the web.
    host_permissions: [
      '*://*.zhipin.com/*',
    ],
    content_scripts: [
      {
        // MAIN world：运行在页面自身上下文，用于 hook 页面的 fetch/XHR 被动捕获接口数据。
        // 必须排在隔离世界脚本之前，否则会漏掉页面首屏发出的请求。
        // world 需要 Chrome 111+。
        matches: [
          '*://*.zhipin.com/*',
        ],
        js: [
          'dist/injected/index.js',
        ],
        run_at: 'document_start',
        world: 'MAIN',
      },
      {
        // ISOLATED world：只做「与页面打交道」的事。
        // 界面全部搬到侧边栏（扩展页面），因为 /wapi/ 接口必须携带页面 Cookie，
        // 只能由内容脚本代侧边栏发起请求。
        matches: [
          '*://*.zhipin.com/*',
        ],
        js: [
          'dist/contentScripts/index.global.js',
        ],
        run_at: 'document_idle',
      },
    ],
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
