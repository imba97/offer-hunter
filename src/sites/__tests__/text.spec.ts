import { describe, expect, it } from 'vitest'
import { normalizeLines } from '../text'

/**
 * 文本归一化的测试。
 *
 * 两个站点（BOSS 的 JD 清洗、电鸭的正文读取）共用这一个函数，所以这里钉的是
 * **两边都必须成立的那条契约**：逐行 trim、丢掉空行、去掉零宽字符、用 `\n` 连接。
 * 站点自己的行级规则（BOSS 丢 CSS 水印行）通过 `drop` 走，行为由各自的 spec 覆盖。
 */

describe('normalizeLines', () => {
  it('每行 trim 并丢掉空行，段落之间留一个换行', () => {
    expect(normalizeLines('  第一段  \n\n\n  第二段\t\n')).toBe('第一段\n第二段')
  })

  it('去掉零宽字符与 BOM', () => {
    expect(normalizeLines('\u200B第一行\uFEFF\n第二\u200F行')).toBe('第一行\n第二行')
  })

  /**
   * 这条是这次合并里唯一的**行为变化**，也是顺序为什么重要的原因：
   * `\u200B` 不是 ECMAScript 的空白符，`trim()` 不会去掉它，所以「先去零宽、
   * 再按行过滤」才不会把这种行留成空行（反过来的话结果里会多一个 \n）。
   */
  it('只有零宽字符的行不会留下空行', () => {
    expect(normalizeLines('AAA\n\u200B\nBBB')).toBe('AAA\nBBB')
    expect(normalizeLines('AAA\n\u200B\u200B\uFEFF\nBBB')).toBe('AAA\nBBB')
    expect(normalizeLines('\u200B\nAAA')).toBe('AAA')
    expect(normalizeLines('AAA\n\u200B')).toBe('AAA')
  })

  it('drop 回调按行过滤（站点自己的行级规则走这里）', () => {
    const input = ['/* 注释行 */', '正文一', '/* 注释行 */', '正文二'].join('\n')

    expect(normalizeLines(input, { drop: line => line.startsWith('/*') })).toBe('正文一\n正文二')
  })

  it('drop 只看行本身，拿到的是已 trim、已去零宽的行', () => {
    const seen: string[] = []
    normalizeLines('  \u200B.a{color:red}  \n正文', {
      drop: (line) => {
        seen.push(line)
        return false
      },
    })

    expect(seen).toEqual(['.a{color:red}', '正文'])
  })

  it('换行统一成 \\n（CRLF 也能吃下）', () => {
    expect(normalizeLines('第一行\r\n第二行')).toBe('第一行\n第二行')
  })

  it('全是空白 / 空输入的边界', () => {
    expect(normalizeLines('')).toBe('')
    expect(normalizeLines('   \n\t\n  ')).toBe('')
    expect(normalizeLines('\u200B')).toBe('')
  })

  it('不把单个换行压掉：段落结构就是它', () => {
    expect(normalizeLines('一\n二\n三')).toBe('一\n二\n三')
  })

  it('不修改调用方传进来的东西（纯函数）', () => {
    const input = '  一  \n\n二'
    const snapshot = input
    normalizeLines(input)

    expect(input).toBe(snapshot)
  })
})
