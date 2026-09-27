# Offer Hunter

> 在 BOSS 直聘上用 AI 分析「你的简历 ↔ 岗位 JD」的匹配度，并按你的规则生成定制打招呼语。
> **扩展不代发消息**：招呼语只复制到剪贴板，发送始终由你本人完成。

浏览器扩展（Chrome / Edge / Firefox），基于 [Vite](https://vitejs.dev/) + Vue 3 + TypeScript 构建。

## 它做什么

1. **读取你的简历** —— 在设置页维护简历全文（Markdown）。
2. **抓取 JD** —— 你在 BOSS 职位页点开哪个岗位，扩展就读取那个岗位的描述与招聘者信息。
3. **AI 匹配度分析** —— 用你配置的 AI 平台对比简历与 JD，输出 0–100 的匹配度、命中点与缺失技能。
4. **生成打招呼语** —— 结合简历、JD 与匹配结论生成开场消息；你复制后自己粘贴发送。

```
简历 ──┐
       ├──► AI 匹配度评分 ──► 低于阈值？ ──► 放弃或继续看下一个岗位
JD  ───┘                └──► 达到阈值 ──► 生成定制打招呼语 ──► 复制，你自己发送
```

岗位会被记进本地「账本」（以 securityId 为键），避免同一个岗位被反复分析。

## 当前进度

- [x] 项目脚手架（Vite + Vue 3 + TS + UnoCSS + 多入口扩展）
- [x] 品牌、图标与 Manifest（仅申请 BOSS 直聘域名权限）
- [x] 接口捕获（MAIN world 注入脚本 hook 页面 fetch/XHR）
- [x] 岗位详情抓取与 AI 匹配度评分
- [x] 招呼语生成 + 一键复制（不代填、不代发）
- [x] 浏览器原生侧边栏（岗位详情 / 诊断 / 快捷设置）与设置页
- [x] 简历编辑器（Monaco + Shiki 高亮，按需加载）
- [ ] 简历导入（PDF / GitHub Gist）
- [ ] 投递记录与统计面板
- [ ] 平台自带去重标（haveChatted / isFriend）接入筛选

## 隐私与安全

这是本扩展最重要的边界，请在使用前读一遍：

- **简历会发给第三方 AI**：匹配分析会把简历全文与 JD 一起发送到你配置的 AI 平台。
  若简历含手机号、身份证号等敏感信息，建议先脱敏。
- **API Key 存在 `chrome.storage.local`，且未加密**：能读取本机浏览器数据的人即可拿到。
  建议使用设了额度上限的 Key，而不是主账号的全权 Key。
- **数据只在本机**：扩展没有自建服务端，除你配置的 AI 平台外不向任何第三方发送数据。
- **随时可清空**：设置页 →「AI 平台」→「清空本地数据」会删除简历、API Key、
  平台配置与岗位账本；也可以直接卸载扩展。
- **不代发消息、不碰登录凭据、不逆向签名、不绕过平台频率限制**。
  招呼语生成后由你自己粘贴发送，扩展不点击任何按钮。

## 技术要点

### 编辑器

设置页的简历编辑器是 **Monaco + Shiki**，按 [Shiki 官方 Monaco 集成](https://shiki.style/packages/monaco) 实现：

- `monaco-editor-core` + `@shikijs/monaco` 的 `shikiToMonaco()`
- 语法与主题用**细粒度 bundle** 显式引入（`shiki/core` + `createHighlighterCore`），
  避免 `shiki` 全量入口把所有语言主题都打进产物
- 用 JavaScript 正则引擎而非 Oniguruma WASM，省掉 wasm 资源与 CSP 问题
- **完全本地打包，不引用任何 CDN**：MV3 的 `script-src 'self'` 不可放宽，
  远程托管代码会被商店审核拒绝，也无法离线工作
- **按需加载**：编辑器体积约 4 MB，静态 import 会让整个设置页首屏都背上它，
  因此用 `defineAsyncComponent` 懒加载

### 为什么薪资只能从接口读

BOSS 直聘用自定义字体渲染薪资数字，DOM 的 `textContent` 返回的是 Unicode
私用区字符（U+E000–U+F8FF）而非数字。因此薪资必须以接口的 `salaryDesc` 为准，
DOM 仅作为拿不到接口数据时的 JD 兜底。

### 注入脚本

`/wapi/` 接口只认浏览器会话 Cookie，而 MV3 的 service worker 发起的请求不带页面
Cookie，因此**接口调用只能在页面上下文发起**。扩展通过一个 `world: "MAIN"` 的
注入脚本 hook 页面的 `fetch`/`XMLHttpRequest` 被动捕获响应，零额外请求；
它在 `document_start` 就装好 hook，并把最近一次详情响应缓存下来，
等隔离世界的内容脚本（`document_idle`）主动来取 —— 否则直链打开岗位页时会漏掉首屏请求。

### JD 清洗

BOSS 会在岗位描述里注入反爬水印：`<style>` 标签与一批 `visibility:hidden` /
`font-size:0` 的隐藏元素。清洗时**必须在真实节点上判断可见性** ——
克隆出来的子树已脱离文档，作者样式表的选择器匹配不到它，
`getComputedStyle` 拿不到 `display:none`，水印文字就会混进 JD 并一起发给 AI。

### 设计边界

- **不代点发送**：招呼语只复制到剪贴板，发送始终由用户本人点击
- **不碰登录凭据**：登录态只由用户在浏览器里维护，扩展不代填验证码
- **不逆向签名、不绕过平台频率限制**

## 开发

> 需要 [pnpm](https://pnpm.io/)（未安装可执行 `npm i -g pnpm`）

```bash
pnpm install
pnpm dev
```

然后打开浏览器扩展管理页，**加载已解压的扩展程序，选择 `extension/` 目录**。

Firefox 开发者可改用：

```bash
pnpm dev-firefox
```

`web-ext` 会在 `extension/` 文件变化时自动重载扩展。Vite 已处理大部分 HMR，仍推荐安装 [Extensions Reloader](https://chromewebstore.google.com/detail/extensions-reloader/fimgfedafeadlieiabdeeaodndnlbhid) 以便更干净地硬重载。

### 构建与打包

```bash
pnpm build          # 产物输出到 extension/
pnpm pack           # Chrome：extension.zip + extension.crx
pnpm pack:firefox   # Firefox：用 Firefox 清单重新构建并打包 extension.xpi
```

⚠ 两点注意：

- `pack:xpi` 打的是**当前 `extension/manifest.json`**。Chrome 与 Firefox 的清单不同
  （`side_panel` vs `sidebar_action`），所以 Firefox 包必须走 `pnpm pack:firefox`
  （它会带上 `EXTENSION=firefox` 重新构建），否则打出来的 `.xpi` 装不上。
- `crx pack` 会用到仓库根目录的 `key.pem`（首次运行自动生成，已被 `.gitignore` 忽略）。
  **扩展 ID 由它决定，请务必备份**：换一把钥匙 = 换一个扩展 ID，用户数据与商店身份都会断掉。

### 其他命令

```bash
pnpm lint        # ESLint
pnpm typecheck   # tsc --noEmit
pnpm test        # 单元测试（Vitest）
pnpm test:e2e    # 端到端测试（Playwright，首次需 npx playwright install chromium）
```

> e2e 必须用 Playwright 自带的 Chromium：Chrome 137+ 已不再接受 `--load-extension`，
> 系统的 Chrome 装不上未打包扩展。

## 目录结构

- `src/` —— 主要源码
  - `background/` —— 后台 service worker（AI 调用、账本、转发）
  - `contentScripts/` —— 内容脚本，只做「与页面打交道」的事，没有任何界面
    - `injected/` —— MAIN world 注入脚本（hook 页面 fetch/XHR）
  - `sidepanel/` —— 侧边栏（岗位 / 诊断 / 快捷设置）
  - `options/` —— 设置页（简历、打招呼规则、AI 平台）
  - `components/` —— 共享 Vue 组件（如 Markdown 编辑器）
  - `logic/` —— 领域模型、存储、BOSS 接口与 DOM 读取
  - `platform/ai/` —— AI 三层结构（protocol → platform → factory）
  - `manifest.ts` —— 动态生成的 `manifest.json`，带完整类型支持
- `extension/` —— 扩展打包根目录
  - `assets/` —— 静态资源（图标等）
  - `dist/` —— 构建产物（开发时为 Vite 的 stub 入口）
- `scripts/` —— 开发与打包辅助脚本
- `e2e/` —— Playwright 冒烟测试

## 图标

`extension/assets/` 下的 `icon.svg` 为矢量稿，`icon-16/32/48/128/512.png` 由设计稿导出，`src/assets/logo.png` 供界面使用。更换图标时请同步替换这几处。

## 技术栈

- **Vue 3** —— Composition API + `<script setup>`
- **Vite** —— 开发态 HMR，多入口构建
- **TypeScript** —— 全量类型
- **UnoCSS** —— 原子化 CSS
- **webext-bridge** —— 各上下文间的类型安全通信
- **webextension-polyfill** —— 跨浏览器 WebExtension API

## 许可

[MIT](./LICENSE)
