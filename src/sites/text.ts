/**
 * 站点无关的文本归一化与元素读取。
 *
 * 「一份干净的 JD 文本」在几个站点里是同一条契约，此前各写了一份（BOSS 的水印清洗
 * 顺带丢 CSS 行、电鸭的 `normalizePostText`、V2EX 的 `textOf`）：**逐行 trim、
 * 丢掉空行、去掉零宽字符、用 `\n` 连接**。规则本身站点无关，站点之间的差别只有
 * 「哪些行不算正文」。
 *
 * ⚠ 顺序有讲究：**先去零宽字符，再按行过滤**。
 *   `\u200B` 这类字符不是 ECMAScript 的空白符，`String.trim()` 不会去掉它 ——
 *   反过来做的话，「只有零宽字符的行」会通过 `trim() !== ''` 的检查被保留，等最后
 *   再被替换成空串，于是在 JD 里留下一个空行（实测：`'AAA\n\u200B\nBBB'` →
 *   `'AAA\n\nBBB'`）。先去掉就没有这个中间态。
 *
 *   这个顺序对 BOSS 还有第二个好处：水印的 CSS 类名里混进零宽字符时，
 *   「这一行像不像 CSS」的判定在去零宽之后才不会漏判（漏判的后果是把一行 CSS
 *   当正文发给 AI）。
 */

/** 零宽 / 不可见特殊字符，以及反爬常用的 BOM 填充 */
const ZERO_WIDTH = /[\u200B-\u200F\u2028-\u202F\uFEFF]/g

export interface NormalizeLinesOptions {
  /**
   * 逐行判断「这一行不是正文」，返回 true 即丢掉。
   *
   * 站点自己的行级规则走这里（BOSS 丢形如 `.ClassName{...}` 的水印行），而不是在
   * 共用函数里加 `dropCssNoise` 之类的布尔开关 —— 那等于把站点知识搬进通用代码。
   */
  drop?: (line: string) => boolean
}

/**
 * 逐行归一化：去零宽字符 → 每行 trim → 丢掉空行与 `drop` 掉的行 → `\n` 连接。
 *
 * 段落之间只留一个换行（不保留空行）：面板按行渲染、AI 也按行读，连续的空白行
 * 只是噪音；要恢复段落感靠的是换行本身。
 */
export function normalizeLines(text: string, options: NormalizeLinesOptions = {}): string {
  const { drop } = options

  return text
    .replace(ZERO_WIDTH, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !drop?.(line))
    .join('\n')
    .trim()
}

/**
 * 读元素的正文文本（已归一化）；元素不存在时返回空串。
 *
 * 独立的理由与 `normalizeLines` 相同：「怎么把一个 DOM 节点读成一段干净文本」在
 * 只读 DOM 的站点里是同一条契约，此前电鸭与 V2EX 各写了一份**逐字相同**的实现
 * （连那句 eslint-disable 都一样）。这类重复的危险在于它是**易错**逻辑：
 * innerText 与 textContent 的取舍踩过一次坑，抄第二份的人不会知道。
 *
 * 两条取舍，都是真机上验证过的：
 *
 *  1. **优先 `innerText`**：它按渲染结果给出换行，而 `textContent` 会把相邻块级元素
 *     的内容直接粘成一行。V2EX 的正文尤其依赖这一点 —— 它的换行是 `<br />`，而
 *     `textContent` **不会**为 `<br>` 生成换行，读出来是一整行糊在一起的 JD，
 *     段落结构（职责 / 要求 / 加分项）全丢，而那是 AI 打分与阅读都要用的信息。
 *  2. **取不到时退回 `textContent`**：jsdom 不实现 innerText，这条兜底让单测能覆盖
 *     共享的归一化逻辑。⚠ 它给不出 `<br>` 换行，这是已知局限，真实浏览器不走这条路。
 *
 * 空判断用 `trim()` 而不是 `length`：全是空白的 innerText 不算「读到了」。
 */
export function readElementText(el: Element | null): string {
  if (!el)
    return ''

  /*
   * 这里刻意用 innerText 而不是 textContent（eslint 的默认偏好正好相反），
   * 理由见上面的第 1 条。
   */
  // eslint-disable-next-line unicorn/prefer-dom-node-text-content
  const inner = (el as HTMLElement).innerText
  const raw = typeof inner === 'string' && inner.trim().length > 0
    ? inner
    : (el.textContent ?? '')

  return normalizeLines(raw)
}
