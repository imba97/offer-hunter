/**
 * 电鸭社区页面相关的「脆弱点」集中管理：DOM 选择器与 URL 判断。
 *
 * 与 BOSS 那份同构：平台改版时只需要改这一个文件，而不是全局搜索散落的 querySelector。
 *
 * 注意：本扩展只**读取**页面，不做任何点击或代填。
 */

/** 帖子标题行（内含分类链接 + 正文标题） */
export const POST_TITLE = 'h1.page-title'

/**
 * 分类链接。
 *
 * 用**直接子元素**选择器（`>`）而不是后代选择器：标题行本身可能包含链接，
 * 后代选择器会把它也算成分类链接。
 */
export const POST_CATEGORY_LINK = 'h1.page-title > a'

/** 帖子正文容器（招聘帖的 JD 就在里面） */
export const POST_BODY = '.post-contents'

/** 标题行里要剔除的装饰性元素（置顶图钉之类的图标，只有 aria-label 没有文字） */
const DECORATION = '[role="img"], .anticon'

/**
 * 已知的招聘分类路径。
 *
 * 真机取到过的两个：`/categories/5`（社区帖子招聘）、`/categories/22`（精选职位推荐）。
 * 它们**不**作为唯一判据（见 isJobCategoryLink）：分类名与分类 id 都可能被平台调整，
 * 两条判据互为兜底。
 */
const JOB_CATEGORY_PATHS = ['/categories/5', '/categories/22']

/**
 * 分类名里的招聘关键词。
 *
 * 覆盖真机的两种分类名：「社区帖子招聘」（含「招聘」）、「精选职位推荐」（含「职位」）。
 * 而反例「分享」（/categories/2）两个都不含 —— 这就是它不被识别的原因。
 */
const JOB_CATEGORY_KEYWORDS = ['招聘', '职位', '内推']

/** 取分类链接的路径（去掉 query / hash）；拿不到返回空串 */
function categoryPath(link: Element): string {
  // 用 getAttribute 而不是 .href：前者就是页面里写的（可能相对路径），
  // 不必依赖 URL 解析，也不会因为 <base> 之类的东西被改写
  const raw = link.getAttribute('href') ?? ''
  if (!raw)
    return ''
  const [path = ''] = raw.split(/[?#]/)
  return path
}

/** 分类链接的展示文本 */
function categoryText(link: Element): string {
  return (link.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 这个分类链接是不是「招聘」类。
 *
 * 两条判据取或：
 *  1. 分类路径在已知招聘分类里（分类名被改也不受影响）
 *  2. 分类名含招聘关键词「招聘 / 职位 / 内推」（新增招聘分类也能认出来）
 *
 * 两条都不是时返回 false —— 例如 `/categories/2`「分享」，那是普通交流帖。
 */
export function isJobCategoryLink(link: Element): boolean {
  const path = categoryPath(link)
  if (JOB_CATEGORY_PATHS.includes(path))
    return true
  return JOB_CATEGORY_KEYWORDS.some(keyword => categoryText(link).includes(keyword))
}

/**
 * 当前页面是不是一个招聘帖。
 *
 * 判据就是标题行里的分类链接（见 isJobCategoryLink）。页面没有标题行
 * （列表页、首页等）时不认。
 */
export function isJobPostPage(root: ParentNode = document): boolean {
  const link = root.querySelector(POST_CATEGORY_LINK)
  return link ? isJobCategoryLink(link) : false
}

/**
 * 从帖子地址里取岗位标识（`/posts/<slug>` 的 slug）。
 *
 * 电鸭的帖子页是 `/posts/z1fRK7`（有时带 `?id=z1fRK7` 之类的查询串）。
 * 站点私有：别的站点用别的形态，因此它只在本目录内使用，由适配器的
 * naturalKeyFromUrl 对外。
 */
export function postIdFromUrl(url: string): string {
  const match = /\/posts\/([^/?#]+)/.exec(url)
  return match ? decodeURIComponent(match[1]) : ''
}

/**
 * 剔除标题行里的分类名与装饰性图标，只留帖子标题。
 *
 * 做法是**按元素删**（克隆一份、摘掉分类链接与图标），而不是按字符串前缀截：
 * `h1.page-title` 的 innerText 是「社区帖子招聘【远程兼职】…」这样连在一起的，
 * 前缀长度取决于分类名（可能是「精选职位推荐」），用字符串截会在分类名变化时
 * 悄悄截错。按元素删则与分类名无关。
 */
export function readPostTitle(root: ParentNode = document): string {
  const title = root.querySelector(POST_TITLE)
  if (!title)
    return ''

  const clone = title.cloneNode(true) as Element
  // 只摘分类链接本身：`:scope >` 保证不会误删正文标题里的链接
  clone.querySelector(':scope > a')?.remove()
  clone.querySelectorAll(DECORATION).forEach(el => el.remove())

  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
}
