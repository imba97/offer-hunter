import { describe, expect, it } from 'vitest'
import { extractCleanText, stripCssNoise } from '../jd'

/**
 * JD 清洗的单测。
 *
 * 这里最有价值的是「真实节点判定可见性」这条回归：曾经在**克隆树**上取
 * getComputedStyle，而游离节点匹配不到作者样式表，水印规则全部失效 ——
 * 症状是反爬水印文本混进 JD 并一起发给 AI（在真实 Chrome 上实测复现过）。
 */

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body.firstElementChild as HTMLElement
}

describe('extractCleanText', () => {
  it('剔除内联隐藏元素及其子树，保留正文', () => {
    const root = mount(`
      <div class="desc">
        <p>负责后端服务开发</p>
        <span style="display:none">WATERMARK-A</span>
        <span style="visibility:hidden">WATERMARK-B</span>
        <span style="font-size:0">WATERMARK-C</span>
        <p>熟悉 TypeScript</p>
      </div>
    `)

    const text = extractCleanText(root)

    expect(text).toContain('负责后端服务开发')
    expect(text).toContain('熟悉 TypeScript')
    expect(text).not.toContain('WATERMARK-A')
    expect(text).not.toContain('WATERMARK-B')
    expect(text).not.toContain('WATERMARK-C')
  })

  it('整棵隐藏子树一起丢掉，不做逐节点比较', () => {
    const root = mount(`
      <div class="desc">
        <div style="display:none">
          <p>水印外层</p>
          <span style="display:block">水印内层</span>
        </div>
        <p>岗位职责：写代码</p>
      </div>
    `)

    const text = extractCleanText(root)

    expect(text).toBe('岗位职责：写代码')
  })

  it('丢掉 style / script 里的 CSS 文本', () => {
    const root = mount(`
      <div class="desc">
        <style>.YmEbSTMBpt{display:none!important}</style>
        <script>var a = 1</script>
        <p>岗位要求：五年经验</p>
      </div>
    `)

    const text = extractCleanText(root)

    expect(text).toContain('岗位要求：五年经验')
    expect(text).not.toContain('YmEbSTMBpt')
    expect(text).not.toContain('var a')
  })

  it('根节点自身被隐藏时返回空串（面板折叠、尚未渲染）', () => {
    const root = mount('<div class="desc" style="display:none"><p>读不到</p></div>')
    expect(extractCleanText(root)).toBe('')
  })

  it('兼容空输入', () => {
    expect(extractCleanText(null)).toBe('')
    expect(extractCleanText(undefined)).toBe('')
  })

  it('不改动页面上的真实节点', () => {
    const root = mount(`
      <div class="desc">
        <span style="display:none">WATERMARK</span>
        <p>正文</p>
      </div>
    `)

    extractCleanText(root)

    // 清洗只发生在克隆上：真实水印节点必须还在（否则页面本身会被改坏）
    expect(root.querySelectorAll('span').length).toBe(1)
  })
})

describe('stripCssNoise', () => {
  it('剔除整行 CSS 规则与裸露的声明片段', () => {
    const input = [
      '.YmEbSTMBpt{display:none!important}',
      '@media (max-width:600px){.a{color:red}}',
      'display:none',
      'font-size:0',
      '岗位职责：负责服务端开发',
    ].join('\n')

    const out = stripCssNoise(input)

    expect(out).toBe('岗位职责：负责服务端开发')
  })

  it('保留像正常文本的花括号内容', () => {
    expect(stripCssNoise('请提交 {姓名} 与 {电话}')).toBe('请提交 {姓名} 与 {电话}')
  })

  it('去掉零宽字符、行尾空白与空行', () => {
    const out = stripCssNoise('第一行   \n\n\u200B第二行\uFEFF')

    expect(out).toBe('第一行\n第二行')
  })

  it('空输入返回空串', () => {
    expect(stripCssNoise('')).toBe('')
  })
})
