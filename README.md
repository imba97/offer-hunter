# Offer Hunter

English | [简体中文](./README_CN.md)

[![Release](https://img.shields.io/github/v/release/imba97/offer-hunter)](https://github.com/imba97/offer-hunter/releases)
[![License](https://img.shields.io/github/license/imba97/offer-hunter)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-4b8bbe)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Browsers](https://img.shields.io/badge/browsers-Chrome%20%7C%20Edge%20%7C%20Firefox-4b8bbe)](#install)
[![Outreach](https://img.shields.io/badge/outreach-sent%20by%20you%20only-149e9b)](#design-boundaries)

<p align="center">
  <img src="./extension/assets/icon-128.png" alt="Offer Hunter" width="128">
</p>

Scores how well your resume matches a job posting on BOSS Zhipin, then drafts a tailored opener for you. It lives in the browser's side panel, sends nothing but the job you clicked and your own resume to the AI platform you configure, and never sends the message itself — you copy, you paste, you click send.

## Features

- 🎯 **AI match scoring** — your resume against the JD, scored 0–100 with the hits, the reasons and the missing skills.
- ✍️ **Tailored openers** — an opening message drawn from your real experience, with your own rules taking priority over the built-in ones.
- 📋 **Copy, never send** — the opener goes to your clipboard; sending stays your click.
- 🔌 **Your AI, your choice** — DeepSeek, OpenAI, Anthropic, Kimi, or a local model that keeps your resume on your machine.
- 🧾 **Local job ledger** — the score and the opener for each posting are kept on your machine, so returning to a job does not mean paying for the same analysis twice.
- 🧭 **Out of the page's way** — the UI lives in the browser's side panel and injects nothing into the BOSS page.
- 🩺 **Built-in diagnostics** — one click re-verifies the page selectors and API contract, so a site change tells you exactly what broke.

## How it works

```text
resume (Markdown) ──┐
job JD (captured) ──┴──> AI match score ──> opener ──> copy, you send
```

1. **You keep one resume as Markdown.** It is written and stored locally in the extension's options page.
2. **You open a job on BOSS.** The extension captures that one posting — never the list, never a queue, never anything you did not click.
3. **You ask for a match analysis.** The request goes through the background service worker to your AI platform, with the resume and the JD together.
4. **You get a number and a reason.** Score, hit points and missing skills land in the side panel, and the result is written to the local ledger.
5. **You decide what happens next.** There is no threshold and no queue: generate an opener for the jobs worth it, then copy it and paste it into the chat yourself.

## Install

Offer Hunter reads your resume and sends it to a third-party AI endpoint, so it is worth installing from a build you can inspect.

### Option 1 — Build from source

```bash
pnpm install
pnpm build
```

Then open your browser's extension page, turn on developer mode, and load the `extension/` directory as an unpacked extension.

- Chrome / Edge: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick `extension/`
- Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick `extension/manifest.json`

### Option 2 — Prebuilt release

Every [GitHub Release](https://github.com/imba97/offer-hunter/releases) carries two artifacts built by CI:

- `extension.zip` — unzip it and load the folder as an unpacked extension in Chrome or Edge
- `extension.xpi` — the Firefox build. It is unsigned, so Firefox Release will refuse it; use Firefox Developer Edition or Nightly, or load it as a temporary add-on via `about:debugging`

There is no store link in this repository yet, so use one of the options above.

### Compatibility

- **Chrome / Edge 111+** — 111 is the floor for `world: "MAIN"` content scripts; the click-the-icon-to-open-the-panel behaviour needs 116+, and degrades to opening the panel from the browser's own side panel button
- **Firefox 128+** — for MAIN-world content scripts and the MV3 sidebar
- **Node.js 20+ and pnpm 11** — only to build from source

## Usage

1. **Configure an AI platform.** Open the options page, pick a provider, paste an API key, and press **Test connection**. The test reports the resolved provider, model and latency, so a wrong base URL, key or model name is caught here rather than in the middle of a job search.
2. **Paste your resume.** The options page has a Markdown editor with syntax highlighting and undo history. Content saves as you type; length and last-updated time are shown next to it.
3. **Set your rules for the opener.** The greeting rules box is free-form — anything you put there is appended to the generation prompt with the highest priority.
4. **Browse jobs normally.** Click any posting on the BOSS jobs page, open the side panel, and the job appears there. Then:

   - **Match analysis** — score the job against your resume
   - **Generate opener** — available whether or not you analysed first; the match result just makes it sharper
   - **Copy** — puts the message on your clipboard for you to paste

The side panel also has a **Diagnostics** tab for verifying that page capture still works, and a **Settings** tab for the two things you reach for mid-session: whether your resume and API key are in place, and a connection test.

## Supported AI platforms

| Platform | Protocol | Structured output | Notes |
| --- | --- | --- | --- |
| DeepSeek | OpenAI-compatible | JSON object | Good Chinese output at a low price. Thinking mode is turned off by default so short answers come back directly |
| OpenAI | OpenAI | JSON schema | The strictest structured-output support, so the most reliable parsing |
| Anthropic | Anthropic Messages | Tool use | Strong on long context and instruction following |
| Kimi | Anthropic-compatible | Prompted JSON | Moonshot's endpoint, authenticated with a bearer token |
| Custom | OpenAI-compatible | Prompted JSON | Relays, self-hosted gateways, and local models — the option where your resume never leaves your machine |

Base URL, model and max output tokens are overridable on every preset, and there is a one-click connection test. A local endpoint such as Ollama or LM Studio is a first-class choice here, not an afterthought: it is the only configuration in which neither your resume nor the job description is sent to a third party.

## Privacy and security

This is the most important boundary of the project, so please read it before installing.

- **Your resume is sent to a third-party AI.** Match analysis and opener generation both send the resume together with the JD to the endpoint you configured. If your resume contains a phone number, ID number or similar, redact it first.
- **The API key is stored unencrypted in `chrome.storage.local`.** Anyone who can read the browser profile on this machine can read it. Use a key with a spending cap rather than your main account's key.
- **Data stays on your machine.** There is no backend service. Apart from the AI endpoint you configured, nothing is sent anywhere.
- **Narrow permissions.** Host access is limited to `zhipin.com`, so the extension cannot read any other site you visit.
- **You can clear everything.** Options page → AI platforms → clear local data removes the resume, API key, platform settings and the job ledger. Uninstalling the extension does the same.
- **Requests are made by the extension's own background worker,** so the API key never enters a web page's context.

## Design boundaries

These are deliberate constraints, not a backlog:

- **No sending on your behalf.** The opener is copied to the clipboard and the send button stays yours. The extension clicks nothing on the page.
- **No credentials.** Sign-in state lives only in your browser; the extension never fills or reads verification codes.
- **No signature reversing and no rate-limit circumvention.**
- **No bulk collection.** Only the posting you clicked is read. There is no crawler, no queue and no background scraping of listings.

## Implementation notes

A few problems in this project had non-obvious answers, and they shape the architecture.

### Capturing job data from the page

The `/wapi/` endpoints authenticate with the browser session cookie, and a Manifest V3 service worker's requests do not carry page cookies — so those calls can only be made from the page's own context. The extension therefore hooks `fetch` and `XMLHttpRequest` from a `world: "MAIN"` content script and passively captures responses, adding zero extra requests. It installs the hook at `document_start` and caches the most recent detail response, which an isolated-world content script then picks up at `document_idle`; without that handshake, opening a job by direct link would miss the first-screen request entirely.

### Two messaging channels, split by tab identity

The side panel and the options page are **extension pages**: they have no tab id. `webext-bridge` routes on the background side through a single "endpoint name → port" slot, and the only context name available to them is `options` — so both pages register into the same slot. Whichever connects last evicts the other, which means a reply can be delivered to the wrong page (the caller then waits forever); worse, when one of the pages closes, the background deletes the shared slot while the other page's port is still alive, and that page's next message dies inside the library on `connMap.get(name).fingerprint`. These two surfaces therefore talk to the background over native `runtime.sendMessage` (see `src/logic/messaging.ts`), where every request is paired with its own response and no slot is shared. The content-script channel does have a tab id, so it keeps using `webext-bridge`, which routes its ports as `content-script@<tabId>`.

### Why salary has to come from the API

BOSS renders salary figures with a custom font, so the DOM's `textContent` returns private-use-area characters (U+E000–U+F8FF) rather than digits. Salary is therefore taken from the API's `salaryDesc` field, with the DOM used only as a last-resort fallback for the JD itself.

### Cleaning the anti-scraping watermark out of the JD

Job descriptions contain an injected watermark: a `<style>` tag plus a set of `visibility: hidden` and `font-size: 0` elements. Visibility must be checked on the **real** nodes — a cloned subtree is detached from the document, author stylesheet selectors no longer match it, `getComputedStyle` reports nothing useful, and the watermark text would sail straight through to the AI.

### Keeping the editor out of the critical path

The resume editor is Monaco plus Shiki, bundled entirely locally: Manifest V3's `script-src 'self'` cannot be relaxed, remotely hosted code is rejected by store review, and it would not work offline anyway. Syntaxes and themes are pulled in through fine-grained Shiki entries using the JavaScript regex engine rather than the Oniguruma WASM build. Because the editor is around 4 MB, it is loaded with `defineAsyncComponent` — otherwise changing an API key would mean downloading the editor first.

## Development

Requires Node.js 20+ and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm dev
```

Then load `extension/` as an unpacked extension in your browser. For Firefox development, use `pnpm dev-firefox` instead.

### Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Development build with HMR, Chrome manifest |
| `pnpm dev-firefox` | Development build with HMR, Firefox manifest |
| `pnpm build` | Production build into `extension/` |
| `pnpm pack` | Chrome: `extension.zip` and `extension.crx` |
| `pnpm pack:firefox` | Firefox: rebuild with the Firefox manifest and pack `extension.xpi` |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:e2e` | End-to-end smoke tests (Playwright) |
| `pnpm release` | Version bump, commit, tag and push |

Use `pnpm pack:firefox` rather than `pnpm pack:xpi` for Firefox: the Chrome and Firefox manifests differ (`side_panel` vs `sidebar_action`), so the Firefox artifact has to be rebuilt first.

## Roadmap

- Resume import from PDF and from a GitHub Gist
- An application tracking and statistics panel
- Using the platform's own dedupe flags (`haveChatted`, `isFriend`) in filtering

## Contributing

Questions, bug reports and pull requests are all welcome — please use the [issue tracker](https://github.com/imba97/offer-hunter/issues) for the first two. Before opening a pull request, make sure the following pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Commit messages follow Conventional Commits so the release changelog stays meaningful. Changes to BOSS's page structure should be confined to `src/logic/boss/selectors.ts`, which exists precisely to keep that fragility in one place.

## Acknowledgments

The project started from [vitesse-webext](https://github.com/antfu-collective/vitesse-webext), a Vite + Vue WebExtension starter, and inherits its multi-entry build setup, HMR wiring and Manifest V3 scaffolding from it.

## License

[MIT](./LICENSE)
