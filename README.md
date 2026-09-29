# Offer Hunter

English | [简体中文](./README_CN.md)

[![Release](https://img.shields.io/github/v/release/imba97/offer-hunter)](https://github.com/imba97/offer-hunter/releases)
[![License](https://img.shields.io/github/license/imba97/offer-hunter)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-4b8bbe)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Browsers](https://img.shields.io/badge/browsers-Chrome%20%7C%20Edge%20%7C%20Firefox-4b8bbe)](#install)

<p align="center">
  <img src="./extension/assets/icon-128.png" alt="Offer Hunter" width="128">
</p>

Scores how well your resume matches a job posting on the recruiting sites it supports, then drafts a tailored opener for you. It lives in the browser's side panel and sends only the job you clicked and your own resume to the AI platform you configure.

```text
resume (Markdown / GitHub Gist) ──┐
job JD (the one you clicked) ─────┴──> AI match score ──> tailored opener
```

## Features

- 🎯 **Match scoring** — your resume against the JD, scored 0–100 with the hits and the missing skills; the scoring criteria are yours to write.
- ✍️ **Tailored openers** — drawn from your real experience, with your own rules taking priority.
- 📄 **A resume that keeps itself current** — write Markdown by hand, or point at a Gist and let it sync; secret gists included, no token needed.
- 🔌 **Your AI, your choice** — DeepSeek / OpenAI / Anthropic / Kimi, or a local model that keeps your resume on your machine.
- 🧾 **Local job ledger** — results stay on your machine, so revisiting a job costs nothing.
- 🗂️ **A jobs entry per platform** — the Jobs tab opens each supported platform's job listing page, in that platform's brand colour.
- 🧭 **Out of the page's way** — the whole UI lives in the browser's side panel; nothing is rendered inside the page.
- 🩺 **Built-in diagnostics** — when a site changes, you see exactly what broke.

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

## Supported job sites

| Site | How it is read | Notes |
| --- | --- | --- |
| [BOSS Zhipin](https://www.zhipin.com/web/geek/jobs) | The site's own API | Captures the job detail responses passively; the richest data (salary, company, recruiter) |
| [eleduck](https://eleduck.com/jobs-channel) | Page DOM only | Reads the title and body of a job post; no structured fields, so company and salary stay empty |
| [V2EX 酷工作](https://www.v2ex.com/go/jobs) | Page DOM only | Only posts filed under the 酷工作 (`/go/jobs`) node count; reads the title and body, so company and salary stay empty |

The side panel's Jobs tab lists one "open jobs page" button per platform, in that platform's brand colour; open any posting from there and it becomes the job under analysis.

## Privacy and security

Read this before installing — it is the most important boundary of the project. The full [privacy policy](./docs/privacy-policy.md) (Chinese) maps every claim back to the source file it comes from.

- **Your resume is sent to a third-party AI.** Match analysis and opener generation both send the resume together with the JD to the endpoint you configured; redact anything sensitive first.
- **A secret gist is not private.** It is merely unlisted and unsearchable, and **anyone holding the link can read it** — no sign-in, no token. Use a private repository if you need real access control.
- **Credentials sit unencrypted on this machine.** The API key (and the optional Gist token) are stored in the browser's local extension data, readable by anyone who can read the browser profile; use a key with a spending cap.
- **Data stays on your machine.** There is no backend service; apart from the AI endpoint you configured, nothing is sent anywhere.
- **Narrow permissions.** Host access is limited to the job sites listed above, so the extension cannot read any other site you visit.
- **You can clear everything.** Options page → AI platforms → clear local data removes the resume, prompts, API key, platform settings and the job ledger; uninstalling does the same.

## Design boundaries

These are deliberate constraints, not a backlog:

- **No page automation.** The extension only reads; it clicks nothing on the page and injects no interface into it.
- **No credentials.** Sign-in state lives only in your browser; the extension never fills or reads verification codes.
- **No signature reversing and no rate-limit circumvention.**
- **No bulk collection.** Only the posting you clicked is read. There is no crawler, no queue and no background scraping of listings.

## Architecture: three extension points

The three places that will keep growing are all adapters — adding one means adding
files, not editing the layers above.

**AI platforms** — `src/platform/ai/`: `protocol` (wire format) → `platform`
(declarative preset table) → `factory`. A new provider is one row in
`platforms/index.ts` (default base URL, model, structured-output capability).

**Resume sources** — `src/logic/resume-sources/`: an adapter contract
(`types.ts`), a registry (one line per source), and one file per source.
A new source is a new adapter file plus a registry line plus one value on
`ResumeSourceId`. The settings dropdown, the source form, and the background
message routing all read the registry and the adapter's declarations, so none of
them needs editing: the form is rendered from `configFields` (inputs),
`normalize` (input coercion) and `itemField` (the item you can only pick after a
fetch) by `components/ResumeSourcePanel.vue` — **an ordinary source needs no UI
code at all**. The sync orchestration (debounce, a 10-minute throttle, the status
machine) is shared in `useResumeSourceSync.ts`.

**Job sites** — `src/sites/`: the adapter contract (`types.ts`, including
`source: 'api' | 'dom'`), the pure-data descriptors the background and build
scripts read (`site-descriptors.ts`), data-driven routing (`routing.ts`), the full
adapter list (`registry.ts`), and one directory per site holding all of that
site's private logic (selectors, API calls, response translation, cleaning),
including one that reads page DOM only. A new site is that directory plus a
descriptor entry plus a registry line. **The manifest's host permissions and
content scripts, and the build output paths, are all derived automatically** —
tab routing, the side panel's per-platform buttons and colours, and the AI
prompts need no changes either.

Two boundaries exist because we hit them:

- **The background imports `routing.ts`/`site-descriptors.ts`, never `registry.ts`.**
  Otherwise every site's selectors and DOM code get pulled into the service worker
  bundle (`querySelector` really did show up in the background output).
- **`SiteId` is an open string, not a literal union.** A closed union forces you to
  edit the domain model just to add a site — the coupling this refactor removed.
  Tests cover it instead (ids unique, ids match directory names).

Two conventions come straight from real sites:

- **`source: 'api' | 'dom'` is the single discriminator for how a site is read.**
  The manifest only injects the MAIN-world script for `'api'` sites (a DOM-only site
  has no API responses to capture, so the hook would be pure intrusion), and the
  content script only runs the API probe and active refetch for them. Because it is
  a discriminated union, declaring `'api'` without implementing the response
  translation does not compile.
- **Everything on `JobCore` except `title` is optional.** Salary, degree, funding
  stage and friends only exist on structured APIs like BOSS's; a DOM-only source
  (eleduck, V2EX) naturally yields just a title and a body, and inventing the rest
  would invent wrong data.

Site information lives outside `JobCore` (in `JobView.site`), so `matching.ts`,
`Sidepanel.vue` and `JobDetailCard.vue` depend only on the site-agnostic
`JobCore` — none of them change when a site is added. The "open the jobs page"
buttons are rendered from the descriptors, colours included.

V2EX brings a question the other sites do not have: **it is a general forum, so a
post is not automatically a job posting.** The "is this page a job?" judgement
therefore lives in the adapter's `readJd` / `readOutline` (it keys off the `/go/jobs`
link in the node breadcrumb, see `sites/v2ex/selectors.ts`), and posts filed under
any other node return `null` — the content script then produces no job at all.

That judgement deliberately stays **out** of the container selectors
(`jdProbeElement` / `jdContainerElement`): they only answer "is the container
there", which is what the observer needs to attach at all. Put the judgement there
and a non-job post leaves the observer retrying its mount every 500ms (see
`sites/types.ts`). Both read functions apply the same predicate independently
rather than pushing it down into the container layer.

The job ledger is keyed by `siteId:naturalKey` (see `recordKey` in
`logic/types.ts`); data from the single-site era is migrated on startup.

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
