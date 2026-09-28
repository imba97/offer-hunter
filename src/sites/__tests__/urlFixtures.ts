/**
 * URL 测试数据：哪些地址属于站点、哪些不属于。
 *
 * 单独成文件是为了让「站点归属」这件事在两处被复用（注册表测试 + 适配器测试），
 * 避免一边加了新用例另一边没跟上。
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

export const NON_SITE_URLS = [
  'https://example.com',
  // 后缀钓鱼：域名不是 zhipin.com，正则必须不认
  'https://zhipin.com.evil.com/web/geek/jobs',
  'https://www.liepin.com/',
  'https://www.51job.com/',
  // 浏览器内部页 / 扩展页
  'chrome://extensions',
  'about:blank',
  // 空值：标签页可能还没加载完，url 为空
  undefined,
  '',
]
