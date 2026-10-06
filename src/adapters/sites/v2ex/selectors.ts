/**
 * V2EX 页面相关的「脆弱点」集中管理：DOM 选择器与 URL 判断。
 *
 * 与 BOSS / 电鸭那两份同构：平台改版时只需要改这一个文件，而不是全局搜索散落的
 * querySelector。
 *
 * 注意：本扩展只**读取**页面，不做任何点击或代填。
 */

/**
 * 主题页右上角的节点头部（V2EX 的「节点」= 版块）。
 *
 * 所有帖子页都有这个容器，**主题页里 `class="header"` 只出现这一次**（真机验证过
 * `https://www.v2ex.com/t/1245478`：全页 `class="header"` 命中 1 个，就是它）。
 * 列表页与节点页用的是 `node-header` / `page-content-header` 这些**别的类名**，
 * 因此 `.header` 这个类选择器不会误命中它们。
 */
export const TOPIC_HEADER = '#Main .header'

/**
 * 「酷工作」节点链接 —— **是不是工作帖子的唯一判据**。
 *
 * V2EX 的节点是帖子属性，节点名写在主题页的节点头部里：
 *
 *   <div class="header">
 *     <div><a href="/">V2EX</a> › <a href="/go/jobs">酷工作</a></div>
 *     <h1>[招聘]: 医疗器械软件工程师…</h1>
 *
 * 所以「这一页属不属于酷工作」就是「头部里有没有这条链接」。真机反例同样验证过：
 * `https://www.v2ex.com/t/1151259`（招聘帖，但发在 `/go/remote`「远程工作」节点）
 * 这里**没有** `/go/jobs` 链接，因此**不**被识别 —— 与需求一致。
 *
 * 用 `href` 属性精确匹配而不是链接文字：`href` 是路由的一部分（改版成本高），
 * 而「酷工作」这个显示名随时可能被改。
 */
export const JOB_NODE_LINK = `${TOPIC_HEADER} a[href="/go/jobs"]`

/** 帖子标题行（主题页有且只有一个 h1） */
export const TOPIC_TITLE = '#Main .header h1'

/**
 * 帖子正文容器（工作帖的 JD 就在里面）。
 *
 * 真机结构很朴素，连换行都是 `<br />`：
 *
 *   <div class="cell">
 *     <div class="topic_content">岗位职责：<br />1.负责…</div>
 *   </div>
 */
export const TOPIC_CONTENT = '#Main .topic_content'

/**
 * 当前页面是不是一个工作帖子（酷工作节点下的主题页）。
 *
 * 两条判据取与，缺一不可：
 *  1. 节点头部里有 `/go/jobs` 链接 → 这个帖子发在酷工作节点
 *  2. 页面有标题行（`h1`）→ 这确实是一个主题页
 *
 * 第二条不是冗余：节点页 `/go/jobs` 的侧栏里也有指向 `/go/jobs` 的链接，只按
 * 第一条判会把**列表页**也认成工作帖（真机验证：`/go/jobs` 页面上有 3 处
 * `/go/jobs` 链接，且没有 h1）。加上 h1 之后列表页天然不认。
 *
 * ⚠ 调用它的是 readJd / readOutline（见 dom.ts），**不是**容器选择器：容器层
 *   只回答「容器在不在」，判定放那里会让非工作帖陷入 500ms 的挂载重试循环。
 */
export function isJobPostPage(root: ParentNode = document): boolean {
  if (!root.querySelector(TOPIC_TITLE))
    return false
  return root.querySelector(JOB_NODE_LINK) !== null
}

/**
 * 从主题地址里取岗位标识（`/t/<id>` 的 id）。
 *
 * 真机上主题页的规范形式就是 `https://www.v2ex.com/t/1245478`（主题页自身的
 * canonical 与 JSON-LD 里都是这个形状），id 全局唯一且永久不变 —— 因此它天然是
 * 账本要的稳定标识，不必像 BOSS 那样退回内容摘要。
 *
 * 站点私有：别的站点用别的形态，因此它只在本目录内使用，由适配器的
 * naturalKeyFromUrl 对外。
 */
export function topicIdFromUrl(url: string): string {
  const match = /\/t\/(\d+)/.exec(url)
  return match ? match[1] : ''
}

/**
 * 读帖标题，并把标题里的换行压成空格。
 *
 * V2EX 的标题里可以有**真换行**（发帖时直接回车，如
 * `https://www.v2ex.com/t/1151259` 的 `<h1>招聘（远程办公-web3）\nGolang 工程师…`）。
 * 这类标题原样读出来，面板上就是断成好几行的标题，账本与提示词里也都带着换行。
 */
export function readTopicTitle(root: ParentNode = document): string {
  const title = root.querySelector(TOPIC_TITLE)
  if (!title)
    return ''
  // 空白（含换行）统一压成单个空格，再去掉首尾
  return (title.textContent ?? '').replace(/\s+/g, ' ').trim()
}
