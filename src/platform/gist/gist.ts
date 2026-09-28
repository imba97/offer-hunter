import { fetchWithTimeout } from '~/platform/http'

/**
 * GitHub Gist 客户端：只做一件事 —— 按 ID/链接取一个 Gist 里的简历文件。
 *
 * **为什么只要 ID，既不需要 token 也不需要「拉取列表」：**
 *
 * 1. **读某一个 Gist 不需要任何权限。** 公开 Gist 如此，secret Gist 也如此 ——
 *    secret 是「不被列出」而不是「要授权」，谁有链接谁能看。实测：不带任何凭据
 *    请求一个 secret Gist，返回 200 与完整文件内容。所以「有链接」就等于「读得到」。
 * 2. **列出名下的 Gist 才需要带 `gist` 权限的 token**，而那条路很容易变成幻觉：
 *    接口没有 visibility 参数，凭据读不到你的 Gist 时它**不报错**，而是按匿名请求
 *    返回全站最新的公开 Gist —— 表现成「只拉到了公开的」，看着像扩展把私有 Gist
 *    丢掉了，实际是权限问题。
 *
 * 少一个字段、少一份要替用户保管的凭据，换来的是「填个 ID 就能用」。因此这里
 * **不发任何凭据**，存储里也不保存 GitHub token —— 扩展唯一要保管的秘密仍然只有 AI Key。
 *
 * 代价只有一个：匿名请求每小时 60 次（够用 —— 每次打开设置页才会同步一次）。
 */

const API_BASE = 'https://api.github.com'

/** 钉住的接口版本，与 `X-GitHub-Api-Version` 一致 */
const GITHUB_API_VERSION = '2022-11-28'

/** 取一个 Gist 可能等上一会儿，但不该让界面永远转圈 */
export const GIST_REQUEST_TIMEOUT_MS = 20_000

export interface GistFileSummary {
  filename: string
  size: number
  language: string | null
}

export interface GistContent {
  gistId: string
  /** 实际取到的文件名（可能是自动挑的，不是用户指定的那个） */
  fileName: string
  markdown: string
  /**
   * 这个 Gist 里的全部文件名。
   *
   * 界面据此提供「换一个文件」的下拉 —— 不给列表之后，这是用户唯一的补救手段，
   * 免得自动挑错了就只能改代码或改 Gist。
   */
  files: string[]
}

export interface GistFetchRequest {
  /** ID 或 `gist.github.com` 链接 */
  gistId: string
  /** 要取的文件名；留空或不存在时自动挑一个 */
  fileName?: string
  /** 可选 token：只为把额度从匿名 60 次/小时提升到 5000 次/小时，不影响读得到什么 */
  token?: string
}

// ---------------------------------------------------------------------------
// 纯函数：地址解析、默认文件挑选
// ---------------------------------------------------------------------------

/** Gist ID 是十六进制串（早期 20 位，新的 32 位） */
const GIST_ID = /^[0-9a-f]{5,64}$/i

/**
 * 把用户输入收敛成 Gist ID。
 *
 * 用户很可能直接粘贴浏览器的地址栏内容，所以链接也要认：
 *   https://gist.github.com/<user>/<id>#file-resume-md
 * 认不出来时返回空串，由调用方给出提示 —— 不猜。
 */
export function parseGistId(input: string): string {
  const trimmed = input.trim()
  if (!trimmed)
    return ''
  if (GIST_ID.test(trimmed))
    return trimmed

  const fromUrl = trimmed.match(/gist\.github\.com\/(?:[^/\s]+\/)?([0-9a-f]{5,64})/i)
  return fromUrl ? fromUrl[1] : ''
}

/** 可能是 Markdown 的文件名 */
const MARKDOWN_EXT = /\.(?:md|markdown|mdx)$/i
/** 退而求其次：纯文本也还能喂给 AI */
const TEXT_EXT = /\.(?:txt|text)$/i

/**
 * 给一个文件打分，分高的更可能是简历。
 *
 * 只看名字与类型，不看内容。用户随时可以在界面上改选。
 */
function scoreResumeFile(file: GistFileSummary): number {
  const name = file.filename.toLowerCase()

  let score = 0
  if (MARKDOWN_EXT.test(name))
    score += 100
  else if (TEXT_EXT.test(name))
    score += 50
  else
    return 0

  if (name === 'resume.md' || name === 'resume.markdown')
    score += 30
  if (name.includes('resume') || name.includes('简历'))
    score += 20
  if (name === 'readme.md')
    score += 10
  return score
}

/**
 * 自动挑一个「最像简历」的文件；挑不出来时返回空串（由 UI 让用户手选）。
 *
 * 只有一个文件时直接用它，不管扩展名 —— 那时的意图没有歧义。
 */
export function pickResumeFile(files: GistFileSummary[]): string {
  if (files.length === 0)
    return ''
  if (files.length === 1)
    return files[0].filename

  const scored = files
    .map(file => ({ file, score: scoreResumeFile(file) }))
    .filter(item => item.score > 0)

  if (scored.length === 0)
    return ''

  scored.sort((a, b) =>
    b.score - a.score
    || b.file.size - a.file.size
    || a.file.filename.localeCompare(b.file.filename))

  return scored[0].file.filename
}

/**
 * 把 HTTP 状态码翻译成一句用户能照做的话。
 *
 * 这里全部是**匿名**请求，所以限流那条按每小时 60 次说 —— 而不是带 token 的 5000 次。
 */
export function gistErrorMessage(
  status: number,
  rateLimitRemaining: string | null,
  apiMessage: string,
): string {
  const detail = apiMessage.trim() ? `（GitHub：${apiMessage.trim()}）` : ''

  if (status === 401)
    return `GitHub 拒绝了这次请求（401）${detail}`
  if (status === 403 && rateLimitRemaining === '0')
    return 'GitHub 匿名请求次数已达上限（每小时 60 次），请稍后再试 —— 填一个 token（可选字段）可提升到每小时 5000 次'
  if (status === 403)
    return `GitHub 拒绝了这次请求（403，可能是限流）${detail}`
  if (status === 404)
    return `取不到这个 Gist（404）：ID 写错了，或者它已经被删除${detail}`
  if (status === 429)
    return 'GitHub 接口请求过于频繁，请稍后再试'
  return `GitHub 接口返回 HTTP ${status}${detail}`
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readFileSummary(value: unknown): GistFileSummary | null {
  if (typeof value !== 'object' || value === null)
    return null
  const file = value as Record<string, unknown>
  const filename = readString(file.filename)
  if (!filename)
    return null
  return {
    filename,
    size: typeof file.size === 'number' ? file.size : 0,
    language: typeof file.language === 'string' ? file.language : null,
  }
}

interface GistFileDetail extends GistFileSummary {
  content: string | null
  truncated: boolean
}

/** `files` 在接口里是「文件名 → 文件对象」的映射，我们只关心值 */
function readFileDetails(value: unknown): GistFileDetail[] {
  if (typeof value !== 'object' || value === null)
    return []

  const out: GistFileDetail[] = []
  for (const raw of Object.values(value as Record<string, unknown>)) {
    const summary = readFileSummary(raw)
    if (!summary)
      continue
    const file = raw as Record<string, unknown>
    out.push({
      ...summary,
      content: typeof file.content === 'string' ? file.content : null,
      truncated: file.truncated === true,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/**
 * 请求头。
 *
 * **没有 token 也照样能读**：公开 Gist 如此，secret Gist 也如此 —— secret 是
 * 「不被列出」而不是「要授权」，谁有链接谁能看（实测：匿名 GET 一个 secret Gist
 * 返回 200 与完整文件内容）。所以 token 只做一件事：把每小时 60 次的匿名额度
 * 提升到 5000 次。有就带，没有就不带。
 */
function requestHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    // 钉住接口版本：GitHub 的默认版本将来会变，响应形状不该跟着悄悄变
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  }
  if (token)
    headers.Authorization = `Bearer ${token}`
  return headers
}

/** 发一个请求，非 2xx 直接翻译成一句人话抛出去。token 可空 */
async function request(path: string, token: string): Promise<Response> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    headers: requestHeaders(token),
  }, GIST_REQUEST_TIMEOUT_MS)

  if (!res.ok) {
    throw new Error(gistErrorMessage(
      res.status,
      res.headers.get('x-ratelimit-remaining'),
      await readApiMessage(res),
    ))
  }

  return res
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  }
  catch {
    throw new Error('GitHub 返回的不是合法 JSON，请稍后重试')
  }
}

/** 错误响应体形如 `{ message, documentation_url }`，取 message 补充细节 */
async function readApiMessage(res: Response): Promise<string> {
  try {
    const raw = await res.json() as unknown
    return readString((raw as Record<string, unknown> | null)?.message)
  }
  catch {
    return ''
  }
}

/**
 * 一份 Gist 内容的稳定标识：同一个 Gist 的同一个文件才算同一份。
 *
 * 存在的意义是取代此前散在两处手工拼接的 `` `${gistId}|${fileName}` ``：
 * 一处负责写入简历、一处负责比较，任何一处改了写法另一处就静默失配
 * —— 症状是「同一份内容每次打开设置页都重取」或者「换了内容却不重取」。
 *
 * 收敛成一个函数后，适配器（gistSource.identify / fetch）比较的是同一个字符串。
 */
export function buildGistContentKey(gistId: string, fileName: string): string {
  return `${gistId}|${fileName}`
}

/**
 * 取一个 Gist 的简历全文。
 *
 * `gistId` 可以是 ID，也可以是 `gist.github.com` 链接。
 * `fileName` 传空（或传了一个该 Gist 里不存在的名字）时自动挑一个。
 * `token` 可空，只影响额度（见 requestHeaders）。
 */
export async function fetchGistContent(
  { gistId, fileName = '', token = '' }: GistFetchRequest,
): Promise<GistContent> {
  const id = parseGistId(gistId)
  if (!id)
    throw new Error('Gist 地址无法识别：请填写 Gist ID，或直接粘贴 gist.github.com 链接')

  const raw = await parseJson(await request(`/gists/${id}`, token.trim()))

  const gist = raw as Record<string, unknown> | null
  const details = readFileDetails(gist?.files)
  const files = details.map(file => file.filename)

  const target = details.some(file => file.filename === fileName)
    ? fileName
    : pickResumeFile(details)

  const detail = details.find(file => file.filename === target)
  if (!detail) {
    throw new Error(details.length === 0
      ? '这个 Gist 里没有文件'
      : '这个 Gist 里没有可用的 Markdown 文件，请在下面手动指定一个文件')
  }

  if (detail.truncated)
    throw new Error(`「${detail.filename}」超过 GitHub 接口 1 MB 的返回上限，同步不了完整内容`)
  if (detail.content === null)
    throw new Error(`「${detail.filename}」没有返回内容，无法同步（可能是二进制文件）`)
  if (detail.content.trim().length === 0)
    throw new Error(`「${detail.filename}」是空文件 —— 请检查是不是选错了文件`)

  return { gistId: id, fileName: detail.filename, markdown: detail.content, files }
}
