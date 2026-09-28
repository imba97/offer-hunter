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

在 BOSS 直聘与电鸭社区上给你的简历与岗位 JD 打分，再替你写一条定制招呼语。它住在浏览器侧边栏里，只把你点开的那个岗位和你的简历发给你自己配置的 AI 平台，消息不由它发出 —— 复制、粘贴、点发送，始终是你自己。

```text
简历（Markdown / GitHub Gist）──┐
岗位 JD（你点开的那个）────────┴──> AI 匹配度 ──> 招呼语 ──> 复制，你自己发送
```

## 特性

- 🎯 **匹配度评分** —— 简历对 JD 打分（0–100），给出命中点与缺失技能，打分口径可以自己写。
- ✍️ **定制招呼语** —— 基于真实经历生成，你的规则优先于内置写法。
- 📄 **简历也可以放 Gist** —— 填链接或 ID 即同步，secret Gist 同样支持，不需要 token。
- 📋 **只复制，不代发** —— 发送始终是你自己那一下点击。
- 🔌 **AI 平台自己选** —— DeepSeek / OpenAI / Anthropic / Kimi，也可用本地模型（简历不出本机）。
- 🧾 **本地岗位账本** —— 结果只存本机，回头看同一个岗位不必重算。
- 🧭 **不打扰页面** —— 界面全在侧边栏，页面里只有一个被动监听接口响应的注入脚本；不点击、不代填、不渲染任何 UI。
- 🩺 **内置诊断** —— 页面改版时能直接看出坏在哪。
- 🧩 **招聘网站可插拔** —— 已支持 BOSS 直聘（走接口）与电鸭社区（只读页面），加一家只需加一个目录。

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
- **权限很窄。** 主机权限只到已支持的招聘网站（`zhipin.com`、`eleduck.com`），读不到你访问的其他网站。
- **随时可以清空。** 设置页 → AI 平台 → 清空本地数据，删除简历、提示词、API Key、平台配置与岗位账本；卸载扩展同理。

## 设计边界

以下是有意为之的约束，不是待办事项：

- **不代发消息。** 招呼语只复制到剪贴板，发送始终由你点击。扩展不点击页面上的任何东西。
- **不碰登录凭据。** 登录态只由你在浏览器里维护，扩展不代填也不读取验证码。
- **不逆向签名，不绕过平台频率限制。**
- **不批量采集。** 只读取你点开的那个岗位。没有爬虫、没有队列、不在后台抓列表。

## 支持的招聘网站

| 站点 | 取数方式 | 说明 |
| --- | --- | --- |
| [BOSS 直聘](https://www.zhipin.com/web/geek/jobs) | 页面接口 | 被动捕获 `/wapi/` 的岗位详情，信息最全（薪资、公司、招聘者） |
| [电鸭社区](https://eleduck.com/jobs-channel) | 只读页面 DOM | 从招聘帖读标题与正文；没有结构化字段，公司/薪资留空 |

侧边栏的「岗位」页会按平台列出各自的职位页入口（按钮用平台主色），点开后任意打开一个岗位/帖子即可分析。

新增一家只需要加一个 `src/sites/<id>/` 目录并在注册表加一行 —— 见下面的架构说明。

## 架构：三个可扩展点

三处「会不断加东西」的地方都做成了适配器，新增一类只加文件、不改上层。

**AI 平台** —— `src/platform/ai/`

`protocol`（wire 格式）→ `platform`（声明式预设表）→ `factory`。新增一家只需在
`platforms/index.ts` 的预设表加一行（声明默认地址、默认模型、结构化输出能力）。

**简历来源** —— `src/logic/resume-sources/`

```text
types.ts          适配器契约（配置字段声明 + normalize + fetch + identify）
registry.ts       注册表：加一行
gist.ts/paste.ts  各自实现
```

新增来源 = 加一个适配器文件 + 在 `registry.ts` 加一行 + 在 `ResumeSourceId` 加一个值。
设置页的下拉框、来源表单、后台的消息路由都从注册表与适配器的声明读，**都不需要改**：
界面由 `components/ResumeSourcePanel.vue` 按 `configFields`（输入框）、`normalize`
（输入收敛）、`itemField`（取完之后才能选的那一项）统一渲染，因此**一个普通来源
不需要写任何界面代码**。同步编排（去抖、10 分钟节流、状态机）在
`useResumeSourceSync.ts` 里共用。

**招聘网站** —— `src/sites/`

```text
types.ts             适配器契约（含 source: 'api' | 'dom' 两种取数方式）
site-descriptors.ts  纯数据（id / 名字 / 职位页 / 配色 / 匹配域名 / 取数方式）—— 后台与构建脚本读它
routing.ts           数据驱动的路由（认站点、匹配模式、提示文案）
registry.ts          完整适配器清单
boss/                某个站点的全部站点私有逻辑（选择器、接口、响应翻译、清洗）
eleduck/             同上，但取数方式是「只读页面 DOM」
```

新增站点 = 加一个 `sites/<id>/` 目录（`index.ts` 适配器 + `content.ts` 入口；
**有接口的站点再加一个 `injected.ts`**）+ 在描述表加一项 + 在注册表加一行。
**manifest 的主机权限与 content_scripts、构建的产物路径全部自动派生**，
后台的标签页路由、侧边栏的平台按钮与配色、AI 提示词也都不需要改。

两条刻意的边界，都是踩过才定下来的：

- **后台只 import `routing.ts`/`site-descriptors.ts`，绝不 import `registry.ts`。**
  否则每个站点的选择器与 DOM 代码会被拖进 service worker 包（实测 `querySelector`
  真的会出现在后台产物里）。`descriptors.ts` 里说明了两者的分工。
- **`SiteId` 是开放字符串，不是字面量联合。** 闭合联合会逼着「加一个站点还要改领域模型」，
  正是这次重构要消掉的耦合；改由测试兜底（id 唯一、与目录名一致）。

两条取自真机的约定：

- **`source: 'api' | 'dom'` 是取数方式的唯一判别。** manifest 只给 `'api'` 的站点注入
  MAIN world 脚本（DOM-only 站点没有接口要捕获，挂 hook 是纯侵入），内容脚本也只在
  `'api'` 站点跑接口探针与主动补拉。这是联合类型，因此「声明了 `'api'` 却忘了实现接口
  翻译」在编译期就过不去。
- **`JobCore` 里除 `title` 外全部可选，面板必须容忍缺失。** 薪资、学历、融资阶段这些是
  BOSS 那类结构化接口才有的字段；只读 DOM 的来源（电鸭社区）天然只给得出标题与正文，
  硬凑只会凑出错误信息。

站点信息藏在 `JobCore` 之外（`JobView.site`），所以 `matching.ts`、`Sidepanel.vue`、
`JobDetailCard.vue` 只依赖站点无关的 `JobCore` —— 加站点时它们一行都不用改。
「打开职位页」的按钮也由站点描述循环渲染，配色是描述里的一项（`color` / `textColor`）。

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
