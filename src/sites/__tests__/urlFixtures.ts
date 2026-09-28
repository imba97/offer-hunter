/**
 * URL 测试数据：哪些地址属于哪个站点、哪些不属于任何站点。
 *
 * 单独成文件是为了让「站点归属」这件事在多处被复用（注册表测试 + 各站点适配器
 * 测试），避免一边加了新用例另一边没跟上。
 *
 * 关键边界：
 *  - 子域要认（www / m / 城市站），因为用户可能被跳到任意一个
 *  - http 与 https 都要认（旧链接）
 *  - 形似而不同的域名不能认（zhipin.com.evil.com 这种钓鱼式后缀）
 */

export const BOSS_PAGE_URLS = [
  'https://www.zhipin.com/web/geek/jobs',
  'https://www.zhipin.com/job_detail/?securityId=abc123',
  'http://www.zhipin.com/web/geek/jobs',
  'https://zhipin.com/web/geek/jobs',
  'https://m.zhipin.com/web/geek/jobs',
]

export const ELEDUCK_PAGE_URLS = [
  // 职位列表页（「打开职位页」按钮的目标）
  'https://eleduck.com/jobs-channel',
  // 帖子详情页：真正读岗位的地方
  'https://eleduck.com/posts/z1fRK7',
  'https://eleduck.com/posts/z1fRK7?id=z1fRK7',
  'http://eleduck.com/posts/z1fRK7',
  'https://www.eleduck.com/posts/z1fRK7',
]

/** 站点 id → 属于它的地址。加站点时这里也要加一组，否则「认不认得出」没有测试。 */
export const SITE_PAGE_URLS: Record<string, string[]> = {
  boss: BOSS_PAGE_URLS,
  eleduck: ELEDUCK_PAGE_URLS,
}

export const NON_SITE_URLS = [
  'https://example.com',
  // 后缀钓鱼：域名不是 zhipin.com，正则必须不认
  'https://zhipin.com.evil.com/web/geek/jobs',
  // 同理：eleduck.com 之外的都是别的站点
  'https://eleduck.com.evil.com/posts/z1fRK7',
  'https://www.liepin.com/',
  'https://www.51job.com/',
  // 浏览器内部页 / 扩展页
  'chrome://extensions',
  'about:blank',
  // 空值：标签页可能还没加载完，url 为空
  undefined,
  '',
]
