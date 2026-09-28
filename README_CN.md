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

```text
简历（Markdown / GitHub Gist）──┐
岗位 JD（你点开的那个）────────┴──> AI 匹配度 ──> 招呼语 ──> 复制，你自己发送
```

## 特性

- 🎯 **匹配度评分** —— 简历对 JD 打分（0–100），给出命中点与缺失技能。
- ✍️ **定制招呼语** —— 基于真实经历生成，你的规则优先于内置写法。
- 📄 **简历也可以放 Gist** —— 填链接或 ID 即同步，secret Gist 同样支持，不需要 token。
- 📋 **只复制，不代发** —— 发送始终是你自己那一下点击。
- 🔌 **AI 平台自己选** —— DeepSeek / OpenAI / Anthropic / Kimi，也可用本地模型（简历不出本机）。
- 🧾 **本地岗位账本** —— 结果只存本机，回头看同一个岗位不必重算。
- 🧭 **不打扰页面** —— 界面在侧边栏里，不向 BOSS 页面注入任何东西。
- 🩺 **内置诊断** —— 页面改版时能直接看出坏在哪。

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

每个 [GitHub Release](https://github.com/imba97/offer-hunter/releases) 都带两个产物：

- `extension.zip` —— 解压后作为「已解压的扩展程序」加载到 Chrome 或 Edge
- `extension.xpi` —— Firefox 构建。它未经签名，Firefox 正式版会拒绝安装；请用 Firefox Developer Edition 或 Nightly，或通过 `about:debugging` 作为临时附加组件载入

仓库里目前还没有商店链接，请使用上面任一种方式。

### 兼容性

- **Chrome / Edge 111+** —— 点扩展图标开合侧边栏需要 116+，更低版本请从浏览器自带的侧边栏按钮打开
- **Firefox 128+**
- **Node.js 20+ 与 pnpm 11** —— 仅从源码构建时需要

## 支持的 AI 平台

| 平台 | 说明 |
| --- | --- |
| DeepSeek | 中文好、价格低 |
| OpenAI | 结果解析最可靠 |
| Anthropic | 长文本、指令遵循强 |
| Kimi | 长上下文 |
| 自定义端点 | 中转站 / 自建网关 / 本地模型 —— 简历不出本机 |

每家的地址、模型与最大输出 Token 都可覆盖，并提供一键连通性测试。把本地端点（Ollama、LM Studio）当作一等选项是有意的：那是唯一一种简历与 JD 都不离开你机器的配置。

## 隐私与安全

安装前请读一遍，这是本项目最重要的边界。

- **简历会发给第三方 AI。** 匹配与生成都会把简历连同 JD 发到你配置的端点；敏感信息请先脱敏。
- **secret Gist 不等于私有。** 它只是不被列出、搜不到，**拿到链接的人都能读**（不需要登录，也不需要 token）。要真正的访问控制请用私有仓库。
- **凭据以明文存在本机。** API Key（以及可选的 Gist token）存在本机浏览器数据里，能读到它的人就能拿到；建议用设了额度上限的 Key。
- **数据只在本机。** 没有自建服务端，除你配置的 AI 端点外不向任何地方发送数据。
- **权限很窄。** 主机权限只到 `zhipin.com`，读不到你访问的其他网站。
- **随时可以清空。** 设置页 → AI 平台 → 清空本地数据，删除简历、API Key、平台配置与岗位账本；卸载扩展同理。

## 设计边界

以下是有意为之的约束，不是待办事项：

- **不代发消息。** 招呼语只复制到剪贴板，发送始终由你点击。扩展不点击页面上的任何东西。
- **不碰登录凭据。** 登录态只由你在浏览器里维护，扩展不代填也不读取验证码。
- **不逆向签名，不绕过平台频率限制。**
- **不批量采集。** 只读取你点开的那个岗位。没有爬虫、没有队列、不在后台抓列表。

## 路线图

- 简历从 PDF 导入
- 投递记录与统计面板
- 按平台自带的标记过滤掉已聊过的岗位

## 贡献

欢迎提问、报 Bug 与提 PR —— 前两者请走 [Issue](https://github.com/imba97/offer-hunter/issues)。开 PR 前请确认以下命令通过：

```bash
pnpm lint
pnpm typecheck
pnpm test
```

commit message 请遵循 Conventional Commits，以便发布时的 changelog 保持可读。

## 致谢

项目从 [vitesse-webext](https://github.com/antfu-collective/vitesse-webext) 起步。

## 许可

[MIT](./LICENSE)
