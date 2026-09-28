/**
 * JD 文本清洗。
 *
 * BOSS 直聘会在岗位描述里注入**反爬水印**：`<style>` 标签、以及一批
 * `display:none!important` / `visibility:hidden` / `font-size:0` 的隐藏元素，
 * 用来在复制出来的文本里埋追踪标记。
 *
 * 这些内容对用户是噪音（会把 CSS 当成 JD 显示出来），必须剔除。
 *
 * 两条取数路径都要清洗：
 *  1. 接口路径：`postDescription` 理论上是纯文本，但保险起见也过一遍
 *  2. DOM 回退路径：`textContent` 会把隐藏元素的文字和 `<style>` 里的 CSS 一并读出
 *
 * 逐行归一化本身是站点无关的（见 sites/text.ts），这个文件只声明 BOSS 独有的两件事：
 * 页面上的水印节点怎么剪、哪些行是水印而不是正文。
 */

import { normalizeLines } from '../text'

/** 需要整段丢弃的标签（其内容不是正文） */
const DROP_TAGS = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META'])

/**
 * 判断元素是否被隐藏。
 *
 * 用 computedStyle 而不是只看内联 style：水印的隐藏规则多数写在
 * `<style>` 里（如 `.YmEbSTMBpt{display:none!important}`），元素自身往往没有样式属性。
 */
function isHidden(el: Element): boolean {
  let style: CSSStyleDeclaration | null = null
  try {
    style = window.getComputedStyle(el)
  }
  catch {
    style = null
  }

  if (!style) {
    // 拿不到计算样式时退化为看内联样式，聊胜于无
    const inline = (el as HTMLElement).style
    return inline?.display === 'none' || inline?.visibility === 'hidden'
  }

  return style.display === 'none'
    || style.visibility === 'hidden'
    || style.fontSize === '0px'
}

/**
 * 按「真实节点树的可见性」剪掉克隆树里对应的子树。
 *
 * ⚠ 为什么不能直接在克隆树上判断：克隆出来的节点已脱离文档，作者样式表的选择器
 * 匹配不到它，`getComputedStyle` 只会返回空的计算样式（实测 Chrome 如此）。
 * 于是 `.YmEbSTMBpt{display:none!important}` 这类写在 `<style>` 里的水印规则
 * 一条都命中不了，水印文字会原样混进 JD。
 *
 * 两棵树的 children 按下标一一对应（克隆是剪枝前的完整快照），因此可以同步下行；
 * 命中隐藏时整棵子树都不再比较，顺带省掉后代的计算样式查询。
 */
function pruneHidden(source: Element, clone: Element): void {
  // ⚠ 必须取快照：children 是**活**集合，删掉一个节点后下标会整体前移，
  // 两棵树的下标就不再对应（症状是删错节点、正文被误删）。
  const sourceChildren = Array.from(source.children)
  const cloneChildren = Array.from(clone.children)

  for (let i = 0; i < sourceChildren.length; i++) {
    const origin = sourceChildren[i]
    const target = cloneChildren[i]
    if (!target)
      break

    if (isHidden(origin)) {
      target.remove()
      continue
    }
    pruneHidden(origin, target)
  }
}

/**
 * 从元素中提取干净的正文。
 *
 * 做法是「克隆后剔除」而不是直接读 textContent —— 后者会把隐藏水印和 CSS 一起带出来。
 * 之所以克隆：避免为了取文本而改动页面上的真实节点。
 */
export function extractCleanText(root: Element | null | undefined): string {
  if (!root)
    return ''

  // 面板被折叠 / 尚未渲染时没有可读正文，直接返回空
  if (isHidden(root))
    return ''

  const clone = root.cloneNode(true) as Element

  // 1. 用真实节点的可见性剪掉水印（此时克隆还是完整快照，children 一一对应）
  pruneHidden(root, clone)

  // 2. 丢掉 style / script 等非正文标签
  //    （它们通常已被上一步按 display:none 剪掉，这里兜住取不到计算样式的情况）
  for (const tag of DROP_TAGS) {
    clone.querySelectorAll(tag).forEach(el => el.remove())
  }

  // 3. 兜底：万一有没被上面规则命中的 CSS 文本混进来，按特征行剔除
  return stripCssNoise(clone.textContent ?? '')
}

/**
 * 文本层面的兜底清洗。
 *
 * 逐行归一化（去零宽字符、trim、丢空行）交给 sites/text.ts，这里只补上 BOSS 自己的
 * 一条行级规则：**哪些行是水印而不是正文**。
 *
 * 处理两种残留：
 *  - 元素被删除后留下的 CSS 规则文本（形如 `.ClassName{...}` 连续成行）
 *  - 裸露的 CSS 声明片段（`display:none` 这类）
 */
export function stripCssNoise(text: string): string {
  return normalizeLines(text, { drop: isCssRuleLine })
}

/**
 * 判断一行文本是否像 CSS 规则而不是自然语言。
 *
 * ⚠ 判定发生在「已去掉零宽字符」之后（见 sites/text.ts 的顺序说明）：水印的类名里
 *   混进零宽字符时，这里才不会漏判。
 */
function isCssRuleLine(line: string): boolean {
  // at-rule（@media / @supports …）：带花括号基本可断定是 CSS，且内部允许嵌套规则
  if (line.startsWith('@') && line.includes('{'))
    return true

  // 形如 .ClassName{display:none!important;} 可能是多个规则连成一行
  const cssRuleRe = /^[.#]?[\w-]+\s*\{[^{}]*\}\s*;?/

  if (cssRuleRe.test(line)) {
    // 要求整行基本都由规则构成，避免误删形如「{占位}」的正常文本
    let rest = line
    while (rest.length > 0) {
      const m = rest.match(cssRuleRe)
      if (!m || m[0].length === 0)
        break
      rest = rest.slice(m[0].length).trim()
    }
    if (rest.length === 0)
      return true
  }

  // 裸露的 CSS 声明片段
  return /^(?:display|visibility|font-size|font-style|font-weight|position|width|height|line-height|color|opacity)\s*:/.test(line)
}
