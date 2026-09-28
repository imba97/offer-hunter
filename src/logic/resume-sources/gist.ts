import type { ResumeSourceAdapter } from './types'
import { buildGistContentKey, fetchGistContent, parseGistId } from '~/platform/gist/gist'

/**
 * GitHub Gist 简历来源。
 *
 * 读取一个 Gist**不需要任何凭据**（secret Gist 是「不被列出」而不是「要授权」，
 * 谁有链接谁能看），所以 token 是可选的，只为把接口额度从匿名 60 次/小时
 * 提到 5000 次/小时。它不参与 AI 请求。
 *
 * `fileName` / `files` 刻意不在 configFields 里：文件名是同步成功后才知道的
 * （要先取一次才知道这个 Gist 有哪些文件、自动挑中了哪个），属于**取完之后的
 * 补充输入**。它由 GistPicker 的「换一个文件」下拉负责，而不是一张静态表单。
 * 这就是「不是所有来源都能用纯 schema 描述」的例子 —— 契约因此允许自定义 UI。
 */
export interface GistConfig {
  token: string
  gistId: string
  /** 要同步的文件名；留空表示按文件名自动挑一个（见 pickResumeFile） */
  fileName: string
  [key: string]: unknown
}

export function createEmptyGistConfig(): GistConfig {
  return { token: '', gistId: '', fileName: '' }
}

/** 配置里的用户输入可能是链接，先收敛成 ID；认不出来返回空串 */
function resolveGistId(config: Record<string, unknown>): string {
  return parseGistId(typeof config.gistId === 'string' ? config.gistId : '')
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export const gistSource: ResumeSourceAdapter = {
  id: 'gist',
  label: 'GitHub Gist 同步',
  hint: '填链接或 ID 即同步，无需 token',

  createConfig: () => createEmptyGistConfig(),

  configFields: [
    {
      key: 'gistId',
      type: 'text',
      label: 'Gist 链接或 ID',
      placeholder: 'https://gist.github.com/user/<id> 或直接填 ID',
      hint: '填链接或 ID 即自动同步，不需要 token。粘链接会自动取出其中的 ID。',
      warning: 'Secret Gist 只是不被列出，拿到链接的人都能读，请妥善保管。',
    },
    {
      key: 'token',
      type: 'secret',
      label: 'Personal access token',
      optional: true,
      placeholder: 'ghp_… / github_pat_…',
      hint: '填不填都能同步；填上只为提高额度：匿名 60 次/小时 → 5000 次/小时。',
      warning: '明文存在本机。',
    },
  ],

  identify(config) {
    /*
     * 必须与 fetch 返回的 contentKey 用同一套拼法（含文件名），否则防回环会失效：
     * fetch 之后界面会把自动挑中的文件名回写进配置，配置一变就再触发一次自动同步；
     * 此时若 identify 只认 gistId，它算出的 key 与刚记下的 contentKey 对不上，
     * 就会白发第二次请求（实测确实如此）。
     *
     * filename 留空（等自动挑）时算出 `<id>|`，与 fetch 之后的 `<id>|resume.md`
     * 不同 —— 这是可以接受的：那一份是「还没回写文件名」的状态。
     */
    const gistId = resolveGistId(config)
    if (!gistId)
      return ''
    return buildGistContentKey(gistId, str(config.fileName))
  },

  async fetch(config) {
    const gistId = resolveGistId(config)
    if (!gistId)
      throw new Error('Gist 地址无法识别：请填写 Gist ID，或直接粘贴 gist.github.com 链接')

    const content = await fetchGistContent({
      gistId,
      fileName: str(config.fileName),
      token: str(config.token).trim(),
    })

    return {
      markdown: content.markdown,
      // 权威标识来自实际取到的文件 —— 自动挑文件时用户并没有指定过它
      contentKey: buildGistContentKey(content.gistId, content.fileName),
      label: content.fileName,
      // 文件列表随内容一起回传，界面据此提供「换一个文件」
      items: content.files,
    }
  },
}
