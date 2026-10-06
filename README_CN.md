# Offer Hunter

[English](./README.md) | 简体中文

[![Release](https://img.shields.io/github/v/release/imba97/offer-hunter)](https://github.com/imba97/offer-hunter/releases)
[![License](https://img.shields.io/github/license/imba97/offer-hunter)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-4b8bbe)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Browsers](https://img.shields.io/badge/browsers-Chrome%20%7C%20Edge%20%7C%20Firefox-4b8bbe)](#安装)

<p align="center">
  <img src="./extension/assets/icon-128.png" alt="Offer Hunter" width="128">
</p>

给你的简历与招聘网站上的岗位 JD 打分，再替你写一条定制招呼语。它住在浏览器侧边栏里，只把你点开的那个岗位和你的简历发给你自己配置的 AI 平台。

```text
简历（Markdown / GitHub Gist）──┐
岗位 JD（你点开的那个）────────┴──> AI 匹配度 ──> 定制招呼语
```

## 特性

- 🎯 **匹配度评分** —— 简历对 JD 打分（0–100），给出命中点与缺失技能，打分口径可以自己写。
- ✍️ **定制招呼语** —— 基于真实经历生成，你的规则优先于内置写法。
- 📄 **简历来源灵活** —— 手写 Markdown，或填个 Gist 链接/ID 自动同步；secret Gist 同样支持，不需要 token。
- 🔌 **AI 平台自己选** —— DeepSeek / OpenAI / Anthropic / Kimi，也可用本地模型（简历不出本机）。
- 🧾 **本地岗位账本** —— 结果只存本机（扩展自己的 IndexedDB），回头看同一个岗位不必重算。
- 🗂️ **各平台职位页入口** —— 侧边栏「岗位」页一键打开各平台的职位列表页，按钮用平台主色。
- 🧭 **界面不挤页面** —— 全部界面都在浏览器侧边栏里，页面内不渲染任何 UI。
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

安装前请读一遍，这是本项目最重要的边界。完整的[隐私政策](./docs/privacy-policy.md)把每一条结论都对应到了源码位置。

- **简历会发给第三方 AI。** 匹配与生成都会把简历连同 JD 发到你配置的端点；敏感信息请先脱敏。
- **secret Gist 不等于私有。** 它只是不被列出、搜不到，**拿到链接的人都能读**（不需要登录，也不需要 token）。要真正的访问控制请用私有仓库。
- **凭据以明文存在本机。** API Key（以及可选的 Gist token）存在本机浏览器数据里，能读到它的人就能拿到；建议用设了额度上限的 Key。
- **数据只在本机。** 没有自建服务端，除你配置的 AI 端点外不向任何地方发送数据。
- **权限很窄。** 主机权限只到已支持的招聘网站域名（见下面的「支持的招聘网站」），读不到你访问的其他网站。
- **随时可以清空。** 设置页 → AI 平台 → 清空本地数据，删除简历、提示词、API Key、平台配置与岗位账本；卸载扩展同理。

## 设计边界

以下是有意为之的约束，不是待办事项：

- **不操作页面。** 扩展只读取，不点击页面上的任何东西，也不向页面注入界面。
- **不碰登录凭据。** 登录态只由你在浏览器里维护，扩展不代填也不读取验证码。
- **不逆向签名，不绕过平台频率限制。**
- **不批量采集。** 只读取你点开的那个岗位。没有爬虫、没有队列、不在后台抓列表。

## 支持的招聘网站

| 站点 | 取数方式 |
| --- | --- |
| [BOSS 直聘](https://www.zhipin.com/web/geek/jobs) | 页面接口 |
| [电鸭社区](https://eleduck.com/jobs-channel) | 只读页面 DOM |
| [V2EX 酷工作](https://www.v2ex.com/go/jobs) | 只读页面 DOM |
| [影视飓风](https://mediastorm.jobs.feishu.cn/index/position) | 页面接口（飞书招聘 ATS） |

侧边栏的「岗位」页会按平台列出各自的职位页入口（按钮用平台主色），点开后任意打开一个岗位/帖子即可分析。

## 架构：三个可扩展点

三处「会不断加东西」的地方都做成了适配器，而且**都按目录约定自动索引**：
新增一个 = 建一个目录，注册表、manifest、界面都不需要改。

**AI 平台** —— `src/platform/ai/platforms/<id>/index.ts`

默认导出 `defineAiPlatform({ ... })`（协议、默认地址与模型、能力、展示文案）。
`platforms/index.ts` 用 `import.meta.glob` 收全部平台，设置页下拉框与工厂都从它读。

**简历来源** —— `src/logic/resume-sources/<id>/index.ts`

默认导出 `defineResumeSource({ ... })`。设置页的下拉框、来源表单、后台的消息路由
都从注册表与适配器的声明读：界面由 `components/ResumeSourcePanel.vue` 按
`configFields`（输入框）、`normalize`（输入收敛）、`itemField`（取完之后才能选的那一项）
统一渲染，因此**一个普通来源不需要写任何界面代码**。同步编排（去抖、10 分钟节流、
状态机）在 `useResumeSourceSync.ts` 里共用。

**招聘网站** —— `src/sites/<id>/`

```text
meta.ts       纯数据：defineSiteMeta({ id / 名字 / 职位页 / 配色 / 匹配域名 / 取数方式 })
index.ts      适配器：defineSite({ meta, ... })，默认导出
content.ts    内容脚本入口（每个站点一份）
injected.ts   MAIN world 注入脚本入口（只有 source: 'api' 的站点需要）
```

注册表（`registry.ts`）glob 各站点的 `index.ts`，路由器（`routing.ts`）glob 各站点的
`meta.ts` —— 后者只含纯数据，因此后台包不会被拖进任何选择器与 DOM 代码。
**manifest 的主机权限与 content_scripts、构建的产物路径全部自动派生**，
后台的标签页路由、侧边栏的平台按钮与配色、AI 提示词也都不需要改。

平台类站点（飞书招聘这种「一套前端 + 一家一个子域」的）多一层：平台共用逻辑在
`src/platform/feishu/`，每个租户仍是 `src/sites/<公司>/`（与其他站点同形，
meta 自己声明公司名与子域，index 一行 `feishuAtsSite(meta, { subdomain, path })`）。

岗位账本以 `siteId:naturalKey` 为键（见 `logic/types.ts` 的 `recordKey`），
旧数据（键只是 BOSS 的 securityId）在启动时迁移一次，不会丢。

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
