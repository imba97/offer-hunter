# Offer Hunter

[English](./README.md) | 简体中文

[![Release](https://img.shields.io/github/v/release/imba97/offer-hunter)](https://github.com/imba97/offer-hunter/releases)
[![License](https://img.shields.io/github/license/imba97/offer-hunter)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-4b8bbe)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Browsers](https://img.shields.io/badge/browsers-Chrome%20%7C%20Edge%20%7C%20Firefox-4b8bbe)](#安装)
[![Outreach](https://img.shields.io/badge/outreach-sent%20by%20you%20only-149e9b)](#设计边界)

<p align="center">
  <img src="./extension/assets/icon-128.png" alt="Offer Hunter" width="128">
</p>

在 BOSS 直聘上给你的简历与岗位 JD 打分，再替你写一条定制招呼语。它住在浏览器侧边栏里，只把你点开的那个岗位和你的简历发给你自己配置的 AI 平台，消息不由它发出 —— 复制、粘贴、点发送，始终是你自己。

## 特性

- 🎯 **AI 匹配度评分** —— 简历对 JD 打分，给出 0–100 的分数、命中点、理由与缺失技能。
- ✍️ **定制招呼语** —— 基于你真实经历生成开场消息，你的规则优先于内置写法。
- 📋 **只复制，不代发** —— 招呼语只进剪贴板，发送始终是你自己那一下点击。
- 🔌 **AI 平台自己选** —— DeepSeek、OpenAI、Anthropic、Kimi，也可用本地模型，简历不出本机。
- 🧾 **本地岗位账本** —— 处理过的岗位会被记下，不再重复分析、重复打招呼。
- 🧭 **不打扰页面** —— 界面在浏览器侧边栏里，不向 BOSS 页面注入任何东西。
- 🩺 **内置诊断** —— 一键复验页面选择器与接口契约，平台改版时能直接看出坏在哪。

## 工作方式

```text
简历（Markdown）──┐
岗位 JD（已捕获）──┴──> AI 匹配度
                          ├──> 低于阈值 ──> 跳过，看下一个
                          └──> 达到阈值 ──> 生成招呼语 ──> 复制，你自己发送
```

1. **你维护一份 Markdown 简历。** 在扩展的设置页里撰写，内容只存在本机。
2. **你在 BOSS 上点开一个岗位。** 扩展只捕获这一个岗位 —— 不遍历列表、不做队列、不碰任何你没点过的东西。
3. **你请求匹配度分析。** 请求经后台 service worker 发往你配置的 AI 平台，简历与 JD 一起送过去。
4. **你拿到一个数字和理由。** 分数、结论、命中点与缺失技能显示在侧边栏，结果同时写入本地账本。
5. **分数达到阈值时，你生成招呼语。** 复制它，自己粘贴到聊天框里发送。

## 安装

Offer Hunter 会读取你的简历并发往第三方 AI 端点，所以值得从一个你能自己检查的构建开始用。

### 方式一：从源码构建

```bash
pnpm install
pnpm build
```

然后打开浏览器的扩展管理页，开启开发者模式，把 `extension/` 目录作为「已解压的扩展程序」加载。

- Chrome / Edge：`chrome://extensions` → 打开**开发者模式** → **加载已解压的扩展程序** → 选择 `extension/`
- Firefox：`about:debugging#/runtime/this-firefox` → **临时载入附加组件** → 选择 `extension/manifest.json`

### 方式二：用预构建的 Release

每个 [GitHub Release](https://github.com/imba97/offer-hunter/releases) 都带两个由 CI 产出的产物：

- `extension.zip` —— 解压后作为「已解压的扩展程序」加载到 Chrome 或 Edge
- `extension.xpi` —— Firefox 构建。它未经签名，Firefox 正式版会拒绝安装；请用 Firefox Developer Edition 或 Nightly，或通过 `about:debugging` 作为临时附加组件载入

仓库里目前还没有商店链接，请使用上面任一种方式。

### 兼容性

- **Chrome / Edge 111+** —— 111 是 `world: "MAIN"` 内容脚本的下限；「点扩展图标开合侧边栏」需要 116+，低版本会退化为从浏览器自带的侧边栏按钮打开
- **Firefox 128+** —— 需要 MAIN world 内容脚本与 MV3 侧边栏
- **Node.js 20+ 与 pnpm 11** —— 仅从源码构建时需要

## 使用

1. **配置 AI 平台。** 打开设置页，选平台、填 API Key，点**测试连通性**。测试会回报实际生效的平台、模型与延迟，接口地址、Key 或模型名任一填错都会在这里暴露，而不是在投递到一半时才发现。
2. **粘贴简历。** 设置页提供带语法高亮与撤销栈的 Markdown 编辑器，内容随输入自动保存，旁边会显示字数与最后更新时间。
3. **设定阈值与规则。** 阈值决定什么时候建议生成招呼语；招呼语规则框是自由文本，写进去的内容会以最高优先级追加到生成提示词里。
4. **照常浏览岗位。** 在 BOSS 职位页点开任意一个岗位卡片，打开侧边栏，岗位就会出现在那里。之后：

   - **匹配度分析** —— 用简历给这个岗位打分
   - **生成招呼语** —— 无论是否先分析过都能用，有匹配结果只会写得更贴合
   - **复制** —— 把消息放进剪贴板，由你粘贴

侧边栏还有 **诊断** 标签用于确认页面捕获是否仍然正常，以及 **设置** 标签用于处理两件你会在投递过程中反复用到的操作：调阈值与测连通性。

## 支持的 AI 平台

| 平台 | 协议 | 结构化输出 | 说明 |
| --- | --- | --- | --- |
| DeepSeek | OpenAI 兼容 | JSON object | 中文场景表现好、价格低。默认关闭思考模式，短输出会直接出现在正文里 |
| OpenAI | OpenAI | JSON schema | 结构化输出约束最严格，解析最可靠 |
| Anthropic | Anthropic Messages | Tool use | 长文本与指令遵循能力强 |
| Kimi | Anthropic 兼容 | Prompt 约束 JSON | Moonshot 端点，用 Bearer 鉴权 |
| 自定义 | OpenAI 兼容 | Prompt 约束 JSON | 中转站、自建网关与本地模型 —— 简历不出本机的那一种 |

每一家的接口地址、模型与最大输出 Token 都可以覆盖，并且提供一键连通性测试。把本地端点（例如 Ollama 或 LM Studio）当作一等选项而非附带支持，是有意的：那是唯一一种简历与 JD 都不会离开你机器的配置。

## 隐私与安全

这是本项目最重要的边界，请在安装前读一遍。

- **简历会发给第三方 AI。** 匹配分析与招呼语生成都会把简历连同 JD 发送到你配置的端点。若简历含手机号、身份证号等敏感信息，建议先脱敏。
- **API Key 以明文存在 `chrome.storage.local`。** 能读取本机浏览器数据的人即可拿到。建议使用设了额度上限的 Key，而不是主账号的全权 Key。
- **数据只在本机。** 扩展没有自建服务端，除你配置的 AI 端点外不向任何地方发送数据。
- **权限范围很窄。** 主机权限只到 `zhipin.com`，因此它读不到你访问的其他任何网站。
- **随时可以清空。** 设置页 → AI 平台 → 清空本地数据，会删除简历、API Key、平台配置与岗位账本；卸载扩展同理。
- **请求由扩展自己的后台 worker 发起，** API Key 不会进入任何网页上下文。

## 设计边界

以下是有意为之的约束，不是待办事项：

- **不代发消息。** 招呼语只复制到剪贴板，发送始终由你点击。扩展不点击页面上的任何东西。
- **不碰登录凭据。** 登录态只由你在浏览器里维护，扩展不代填也不读取验证码。
- **不逆向签名，不绕过平台频率限制。**
- **不批量采集。** 只读取你点开的那个岗位。没有爬虫、没有队列、不在后台抓列表。

## 实现要点

项目里有几个问题没有显而易见的答案，而它们决定了整体架构。

### 从页面捕获岗位数据

`/wapi/` 接口只认浏览器会话 Cookie，而 MV3 的 service worker 发起的请求不带页面 Cookie —— 所以这些调用只能在页面自身的上下文里发起。扩展因此用 `world: "MAIN"` 的内容脚本 hook 页面的 `fetch` 与 `XMLHttpRequest` 被动捕获响应，零额外请求。它在 `document_start` 就装好 hook 并缓存最近一次详情响应，隔离世界的内容脚本再到 `document_idle` 把它取走；没有这次交接，直链打开岗位页会漏掉首屏请求。

### 扩展页面与内容脚本走两条消息通道

侧边栏与设置页都是**扩展页面**，没有 tabId。而 `webext-bridge` 在后台是「端点名 → 端口」的单槽位路由，这两个页面能用的上下文名只有 `options`，于是它们注册进同一个槽位：后连上的把先连上的挤掉，发给其中一页的回复会落到另一页（那一侧只能一直转圈）；更糟的是其中一页关闭时，后台会把整个槽位删掉，而另一页的端口还活着 —— 它之后发出的消息会在库内部直接抛 `connMap.get(名字).fingerprint` 的错。因此这两个界面与后台之间一律用原生 `runtime.sendMessage`（见 `src/logic/messaging.ts`）：一问一答天然配对，不存在共享槽位。内容脚本那条链路有 tabId，继续用 `webext-bridge`（它按 `content-script@<tabId>` 路由端口）。

### 为什么薪资只能从接口读

BOSS 用自定义字体渲染薪资数字，DOM 的 `textContent` 返回的是 Unicode 私用区字符（U+E000–U+F8FF）而非数字。因此薪资以接口的 `salaryDesc` 为准，DOM 只作为拿不到接口数据时的 JD 兜底。

### 从 JD 里清洗反爬水印

岗位描述里被注入了水印：一个 `<style>` 标签，加上一批 `visibility: hidden` / `font-size: 0` 的隐藏元素。可见性**必须在真实节点上判断** —— 克隆出来的子树已脱离文档，作者样式表的选择器匹配不到它，`getComputedStyle` 也拿不到有用信息，水印文字就会原样混进 JD 发给 AI。

### 不让编辑器挡住首屏

简历编辑器是 Monaco + Shiki，完全本地打包：MV3 的 `script-src 'self'` 不可放宽，远程托管代码会被商店审核拒绝，也无法离线工作。语法与主题通过 Shiki 的细粒度入口引入，并使用 JavaScript 正则引擎而非 Oniguruma WASM 构建。编辑器体积约 4 MB，因此用 `defineAsyncComponent` 懒加载 —— 否则只想改一下 API Key 也要先下载整个编辑器。

## 开发

需要 Node.js 20+ 与 [pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm dev
```

然后在浏览器里把 `extension/` 作为已解压的扩展加载。Firefox 开发改用 `pnpm dev-firefox`。

### 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发构建 + HMR，Chrome 清单 |
| `pnpm dev-firefox` | 开发构建 + HMR，Firefox 清单 |
| `pnpm build` | 生产构建，产物输出到 `extension/` |
| `pnpm pack` | Chrome：`extension.zip` 与 `extension.crx` |
| `pnpm pack:firefox` | Firefox：用 Firefox 清单重新构建并打包 `extension.xpi` |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | 单元测试（Vitest） |
| `pnpm test:e2e` | 端到端冒烟测试（Playwright） |
| `pnpm release` | 改版本号、提交、打 tag 并推送 |

Firefox 包请用 `pnpm pack:firefox` 而不是 `pnpm pack:xpi`：两份清单不同（`side_panel` 与 `sidebar_action`），必须先用 Firefox 清单重新构建。

## 路线图

- 简历导入（PDF 与 GitHub Gist）
- 投递记录与统计面板
- 接入平台自带的去重标记（`haveChatted`、`isFriend`）参与筛选

## 贡献

欢迎提问、报 Bug 与提 PR —— 前两者请走 [Issue](https://github.com/imba97/offer-hunter/issues)。开 PR 前请确认以下命令通过：

```bash
pnpm lint
pnpm typecheck
pnpm test
```

commit message 请遵循 Conventional Commits，以便发布时的 changelog 保持可读。涉及 BOSS 页面结构的改动请收敛在 `src/logic/boss/selectors.ts` —— 这个文件存在的意义就是把这份脆弱性集中在一处。

## 致谢

项目从 [vitesse-webext](https://github.com/antfu-collective/vitesse-webext) 起步，多入口构建、HMR 接线与 Manifest V3 脚手架都继承自这个 Vite + Vue 扩展模板。

## 许可

[MIT](./LICENSE)
