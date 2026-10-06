/**
 * BOSS 直聘页面相关的「脆弱点」集中管理：DOM 选择器与 URL 判断。
 *
 * 这是整个项目最大的长期脆弱性来源：平台改版时，只需要改这一个文件，
 * 而不是全局搜索散落的 querySelector。
 *
 * 注意：本扩展只**读取**页面，不做任何点击或代填，
 * 因此这里不含聊天输入框、沟通按钮之类的选择器。
 */

/** 职位详情面板里的 JD 正文 */
export const JOB_DETAIL_DESC = '.job-detail-box .job-detail-body .desc'

/** 职位详情容器（观察 DOM 变化、以及在内部找标题/公司名的范围） */
export const JOB_DETAIL_BOX = '.job-detail-box'

/**
 * 岗位名 / 公司名的候选选择器（按顺序取第一个「长度合理」的命中）。
 *
 * ⚠ 这两个字段是为了让**接口没捕获到时的 DOM 兜底岗位**也有可读标题，
 * 而具体类名社区版本之间不一致，因此用「class 关键词」而不是精确类名。
 * 命中的元素必须文本很短（见 dom.ts 的长度上限），否则会把整段公司介绍当成公司名。
 *
 * 真机命中情况看侧边栏「诊断」标签：那里会逐个列出候选的命中数。
 */
export const JOB_TITLE_SELECTORS = [
  'h1',
  '[class*="job-name"]',
  '[class*="jobName"]',
  '[class*="job-title"]',
  '[class*="jobTitle"]',
  'h2',
]

export const JOB_COMPANY_SELECTORS = [
  '[class*="company-name"]',
  '[class*="companyName"]',
  '[class*="brand-name"]',
  '[class*="brandName"]',
  '[class*="company"]',
  '[class*="brand"]',
]

/**
 * 是否是我们注入脚本生效的 BOSS 页面。
 *
 * 后台（判断要不要跳转职位页、找转发目标标签页）与侧边栏（提示当前标签页状态）
 * 都要用同一套判断，放这里避免两处正则各写一遍后改漏。
 *
 * 现在**只由本目录的适配器暴露出去**（sites/boss/index.ts 的 matchUrl），
 * 上层一律通过注册表使用 —— 它们不该知道 zhipin 这个域名。
 */
export function isBossPageUrl(url: string | undefined): boolean {
  if (!url)
    return false
  return /^https?:\/\/(?:[^/]*\.)?zhipin\.com\//.test(url)
}

/**
 * 从 URL 里取岗位的 securityId（详情接口的钥匙）。
 *
 * BOSS 特有：别的站点用别的参数名。因此它只在本目录内使用，
 * 由适配器的 naturalKeyFromUrl 对外。
 */
export function securityIdFromUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).searchParams.get('securityId') ?? ''
  }
  catch {
    return ''
  }
}

/** 从 URL 里取路径（去掉查询串与 hash）；地址不可解析时返回空串 */
function pathnameOf(url: string): string {
  try {
    return new URL(url, window.location.origin).pathname
  }
  catch {
    return ''
  }
}

/**
 * 是不是职位列表 / 搜索页（`/web/geek/job`，含 `/web/geek/jobs` 与带查询串的形态）。
 *
 * 这一页要算岗位页：右侧就是详情面板，用户点开卡片后岗位出现在那里。
 * 它不依赖页面当前渲染了什么 —— 面板还在加载时也得认，否则那一瞬间捕到的
 * 详情接口响应会被当成「非岗位页上的数据」丢掉。
 */
export function isJobListUrl(url: string): boolean {
  return pathnameOf(url).startsWith('/web/geek/job')
}

/**
 * 是不是独立职位详情页的路径（`/job_detail/<encryptJobId>.html`，
 * 老形态 `/job_detail/?securityId=…` 也命中）。
 *
 * ⚠ 只是「路径像详情页」，**不等于**岗位页：那条路径有时也承载列表页的右侧面板
 *   （列表页里点卡片后地址会变成它）。两者的区别在页面渲染出来的东西上，
 *   见适配器里的 isJobPage。
 */
export function isJobDetailUrl(url: string): boolean {
  return pathnameOf(url).startsWith('/job_detail')
}
