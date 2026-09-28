import type { ResumeSourceAdapter } from './types'

/**
 * 手动输入（在设置页里直接写 Markdown）。
 *
 * **为什么它也要做成适配器**：不是为了对称好看，而是为了证明这套抽象不是照着
 * Gist 剪裁的 —— 一个「没有配置、不发请求、内容就在眼前」的来源能原样塞进同一个
 * 接口，说明契约里的字段都是必需的（`identify` 这种偏网络来源的概念在这里
 * 退化成空串即可）。
 *
 * 它没有可取的远端内容：`fetch` 只是把「内容就在简历对象里」这件事如实报告回去。
 * 上层拿到的是一个良构的 ResumeContent，因此不需要为它保留一条 if 分支。
 */
export const pasteSource: ResumeSourceAdapter = {
  id: 'paste',
  label: '手动编辑',
  hint: '直接在设置页里写 Markdown',

  createConfig: () => ({}),

  // 没有配置项：表单区域整块不渲染
  configFields: [],

  identify: () => '',

  async fetch() {
    /*
     * 手动输入没有远端可拉 —— 内容由编辑器直接写进 resume.markdown。
     * 这里不返回任何内容（空 markdown 会被调用方忽略），而不是抛错：
     * 「切到手动编辑」是完全正常的操作，不该弹一个同步失败。
     */
    return { markdown: '', contentKey: '' }
  },
}
