import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchGistContent,
  gistErrorMessage,
  parseGistId,
  pickResumeFile,
} from '../gist'

/**
 * Gist 客户端单测。
 *
 * 这个模块只做一件事：按 ID/链接取一个 Gist 里的某个文件。因此要钉住的是
 * 「从用户粘贴的链接里认出 ID」与「一个 Gist 里有多个文件时默认挑哪个」——
 * 这两件出错时的表现分别是「同步了别的 Gist」和「简历变成了一堆笔记」，
 * 都很难从现象反推原因。
 *
 * 网络层用手写的假 Response，不依赖 jsdom 是否提供 fetch/Response。
 */

const GIST_ID = 'aa5a315d61ae9438b18d'

function fakeResponse(
  body: unknown,
  { status = 200, headers = {} }: { status?: number, headers?: Record<string, string> } = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response
}

/** 装一个假的 fetch，返回它收到的调用记录，便于断言请求本身 */
function stubFetch(...responses: Response[]): Array<{ url: string, init: RequestInit }> {
  const calls: Array<{ url: string, init: RequestInit }> = []
  let index = 0

  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const response = responses[Math.min(index, responses.length - 1)]
    index++
    return response
  }))

  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseGistId', () => {
  it('裸 ID 原样返回', () => {
    expect(parseGistId(GIST_ID)).toBe(GIST_ID)
    expect(parseGistId(`  ${GIST_ID}  `)).toBe(GIST_ID)
  })

  it('从 gist.github.com 链接里取 ID（有无用户名、带 #file- 锚点、带查询串）', () => {
    expect(parseGistId(`https://gist.github.com/octocat/${GIST_ID}`)).toBe(GIST_ID)
    expect(parseGistId(`https://gist.github.com/${GIST_ID}`)).toBe(GIST_ID)
    expect(parseGistId(`https://gist.github.com/octocat/${GIST_ID}#file-resume-md`)).toBe(GIST_ID)
    expect(parseGistId(`http://gist.github.com/octocat/${GIST_ID}?plain=1`)).toBe(GIST_ID)
  })

  it('认不出来时返回空串（不猜）', () => {
    expect(parseGistId('')).toBe('')
    expect(parseGistId('  ')).toBe('')
    expect(parseGistId('resume')).toBe('')
    expect(parseGistId('https://github.com/octocat/hello-world')).toBe('')
    // 非十六进制的路径段不是 ID
    expect(parseGistId('https://gist.github.com/octocat/not-a-hex-id')).toBe('')
  })
})

describe('pickResumeFile', () => {
  const file = (filename: string, size = 100) => ({ filename, size, language: null })

  it('只有一个文件时直接用，不管扩展名', () => {
    expect(pickResumeFile([file('notes.py')])).toBe('notes.py')
  })

  it('优先 .md，其次 .txt', () => {
    expect(pickResumeFile([file('a.txt'), file('b.md')])).toBe('b.md')
    expect(pickResumeFile([file('a.py'), file('b.txt')])).toBe('b.txt')
  })

  it('多个 .md 时偏好名字里带 resume 的那个', () => {
    expect(pickResumeFile([file('notes.md'), file('resume.md')])).toBe('resume.md')
    expect(pickResumeFile([file('notes.md'), file('我的简历.md')])).toBe('我的简历.md')
    expect(pickResumeFile([file('readme.md', 999), file('notes.md')])).toBe('readme.md')
  })

  it('同样像简历时取内容更多的那个', () => {
    expect(pickResumeFile([file('a.md', 10), file('b.md', 900)])).toBe('b.md')
  })

  it('没有 md/txt 也没有唯一文件时交给用户手选（空串）', () => {
    expect(pickResumeFile([])).toBe('')
    expect(pickResumeFile([file('a.py'), file('b.json')])).toBe('')
  })
})

describe('gistErrorMessage', () => {
  it('限流按匿名额度说（每小时 60 次），不是 token 的 5000 次', () => {
    const message = gistErrorMessage(403, '0', 'API rate limit exceeded')
    expect(message).toContain('60 次')
  })

  it('404 指向「ID 写错或已删除」', () => {
    expect(gistErrorMessage(404, null, 'Not Found')).toContain('ID 写错了')
  })

  it('其它状态码带上 GitHub 的原话', () => {
    expect(gistErrorMessage(500, null, 'Server Error')).toBe('GitHub 接口返回 HTTP 500（GitHub：Server Error）')
  })
})

describe('fetchGistContent', () => {
  function gistResponse(files: Record<string, unknown>): Response {
    return fakeResponse({ id: GIST_ID, files })
  }

  it('取指定文件的内容，并带出全部文件名', async () => {
    const calls = stubFetch(gistResponse({
      'resume.md': { filename: 'resume.md', size: 5, content: '# 我' },
      'notes.md': { filename: 'notes.md', size: 5, content: '# 笔记' },
    }))

    const content = await fetchGistContent({ gistId: GIST_ID, fileName: 'notes.md' })

    expect(content).toEqual({
      gistId: GIST_ID,
      fileName: 'notes.md',
      markdown: '# 笔记',
      files: ['resume.md', 'notes.md'],
    })
    expect(calls[0].url).toBe(`https://api.github.com/gists/${GIST_ID}`)
  })

  it('不填 token 时不发凭据 —— 读 Gist 不需要权限', async () => {
    const calls = stubFetch(gistResponse({
      'resume.md': { filename: 'resume.md', size: 5, content: '# 我' },
    }))

    await fetchGistContent({ gistId: GIST_ID })

    expect(calls[0].init.headers).not.toHaveProperty('Authorization')
    expect(calls[0].init.headers).toMatchObject({ 'X-GitHub-Api-Version': '2022-11-28' })
  })

  it('填了 token 就带上（只为提额度），并去掉两端空白', async () => {
    const calls = stubFetch(gistResponse({
      'resume.md': { filename: 'resume.md', size: 5, content: '# 我' },
    }))

    await fetchGistContent({ gistId: GIST_ID, token: '  ghp_token  ' })

    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer ghp_token' })
  })

  it('指定的文件不存在时退回自动挑，并回报真正用到的文件名', async () => {
    stubFetch(gistResponse({
      'notes.md': { filename: 'notes.md', size: 5, content: '# 笔记' },
      'resume.md': { filename: 'resume.md', size: 5, content: '# 我' },
    }))

    const content = await fetchGistContent({ gistId: GIST_ID, fileName: '已删除.md' })

    expect(content.fileName).toBe('resume.md')
    expect(content.markdown).toBe('# 我')
  })

  it('粘贴链接也能同步（ID 会被收敛）', async () => {
    stubFetch(gistResponse({ 'resume.md': { filename: 'resume.md', size: 5, content: '# 我' } }))

    const content = await fetchGistContent({ gistId: `https://gist.github.com/octocat/${GIST_ID}` })

    expect(content.gistId).toBe(GIST_ID)
  })

  it('超过 1 MB 被截断时报错说清楚，而不是把半截简历喂给 AI', async () => {
    stubFetch(gistResponse({
      'resume.md': { filename: 'resume.md', size: 2_000_000, content: '# 半截', truncated: true },
    }))

    await expect(fetchGistContent({ gistId: GIST_ID })).rejects.toThrow('1 MB')
  })

  it('空文件报错（多半是选错了文件，不能默默把简历清空）', async () => {
    stubFetch(gistResponse({ 'resume.md': { filename: 'resume.md', size: 0, content: '   \n' } }))

    await expect(fetchGistContent({ gistId: GIST_ID })).rejects.toThrow('空文件')
  })

  it('一个可用文件都没有时给出可照做的提示', async () => {
    stubFetch(gistResponse({ 'a.py': { filename: 'a.py', size: 5, content: 'print(1)' }, 'b.json': { filename: 'b.json', size: 5, content: '{}' } }))

    await expect(fetchGistContent({ gistId: GIST_ID })).rejects.toThrow('手动指定一个文件')
  })

  it('认不出来的 ID 不发请求', async () => {
    const calls = stubFetch(gistResponse({}))

    await expect(fetchGistContent({ gistId: '我的简历' })).rejects.toThrow('Gist 地址无法识别')
    expect(calls).toHaveLength(0)
  })
})
