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

```text
resume (Markdown / GitHub Gist) ──┐
job JD (the one you clicked) ─────┴──> AI match score ──> opener ──> copy, you send
```

## Features

- 🎯 **Match scoring** — your resume against the JD, scored 0–100 with the hits and the missing skills; the scoring criteria are yours to write.
- ✍️ **Tailored openers** — drawn from your real experience, with your own rules taking priority.
- 📄 **Resume from a Gist** — paste a link or id and it syncs; secret gists included, no token needed.
- 📋 **Copy, never send** — sending stays your click.
- 🔌 **Your AI, your choice** — DeepSeek / OpenAI / Anthropic / Kimi, or a local model that keeps your resume on your machine.
- 🧾 **Local job ledger** — results stay on your machine, so revisiting a job costs nothing.
- 🧭 **Out of the page's way** — the UI lives in the side panel and injects nothing into the BOSS page.
- 🩺 **Built-in diagnostics** — when the site changes, you see exactly what broke.

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

Every [GitHub Release](https://github.com/imba97/offer-hunter/releases) carries two artifacts:

- `extension.zip` — unzip it and load the folder as an unpacked extension in Chrome or Edge
- `extension.xpi` — the Firefox build. It is unsigned, so Firefox Release will refuse it; use Firefox Developer Edition or Nightly, or load it as a temporary add-on via `about:debugging`

There is no store link in this repository yet, so use one of the options above.

### Compatibility

- **Chrome / Edge 111+** — clicking the toolbar icon to toggle the side panel needs 116+; below that, open it from the browser's own side panel button
- **Firefox 128+**
- **Node.js 20+ and pnpm 11** — only to build from source

## Supported AI platforms

| Platform | Notes |
| --- | --- |
| DeepSeek | Good Chinese at a low price |
| OpenAI | The most reliable parsing |
| Anthropic | Strong on long context and instructions |
| Kimi | Long context |
| Custom endpoint | Relays / gateways / local models — your resume never leaves your machine |

Base URL, model and max output tokens are overridable on every preset, and there is a one-click connection test. A local endpoint such as Ollama or LM Studio is a first-class choice here, not an afterthought: it is the only configuration in which neither your resume nor the job description is sent to a third party.

## Privacy and security

Read this before installing — it is the most important boundary of the project.

- **Your resume is sent to a third-party AI.** Match analysis and opener generation both send the resume together with the JD to the endpoint you configured; redact anything sensitive first.
- **A secret gist is not private.** It is merely unlisted and unsearchable, and **anyone holding the link can read it** — no sign-in, no token. Use a private repository if you need real access control.
- **Credentials sit unencrypted on this machine.** The API key (and the optional Gist token) are stored in the browser's local extension data, readable by anyone who can read the browser profile; use a key with a spending cap.
- **Data stays on your machine.** There is no backend service; apart from the AI endpoint you configured, nothing is sent anywhere.
- **Narrow permissions.** Host access is limited to `zhipin.com`, so the extension cannot read any other site you visit.
- **You can clear everything.** Options page → AI platforms → clear local data removes the resume, prompts, API key, platform settings and the job ledger; uninstalling does the same.

## Design boundaries

These are deliberate constraints, not a backlog:

- **No sending on your behalf.** The opener is copied to the clipboard and the send button stays yours. The extension clicks nothing on the page.
- **No credentials.** Sign-in state lives only in your browser; the extension never fills or reads verification codes.
- **No signature reversing and no rate-limit circumvention.**
- **No bulk collection.** Only the posting you clicked is read. There is no crawler, no queue and no background scraping of listings.

## Roadmap

- Resume import from PDF
- An application tracking and statistics panel
- Filtering out jobs you have already messaged, using the platform's own flags

## Contributing

Questions, bug reports and pull requests are all welcome — please use the [issue tracker](https://github.com/imba97/offer-hunter/issues) for the first two. Before opening a pull request, make sure the following pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Commit messages follow Conventional Commits so the release changelog stays meaningful.

## Acknowledgments

The project started from [vitesse-webext](https://github.com/antfu-collective/vitesse-webext).

## License

[MIT](./LICENSE)
