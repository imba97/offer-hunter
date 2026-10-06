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

export const V2EX_PAGE_URLS = [
  // 酷工作节点页（「打开职位页」按钮的目标）
  'https://www.v2ex.com/go/jobs',
  // 帖子详情页：真正读岗位的地方
  'https://www.v2ex.com/t/1245478',
  'https://www.v2ex.com/t/1245478#reply3',
  'https://v2ex.com/t/1245478',
  'http://www.v2ex.com/t/1245478',
  // 官方备用域名（部分地区与搜索结果会落到这里）
  'https://global.v2ex.co/t/1245478',
]

export const MEDIASTORM_PAGE_URLS = [
  // 职位列表页（「打开职位页」按钮的目标）
  'https://mediastorm.jobs.feishu.cn/index/position',
  // 岗位详情页：真正读岗位的地方（用户直接打开 / 分享链接的形态）
  'https://mediastorm.jobs.feishu.cn/index/position/7673106028406786331/detail',
  // 站内路由跳转的形态（同一个岗位，另一种路径）
  'https://mediastorm.jobs.feishu.cn/position/detail/7673106028406786331',
  'http://mediastorm.jobs.feishu.cn/index/position/7673106028406786331/detail',
]

/** 站点 id → 属于它的地址。加站点时这里也要加一组，否则「认不认得出」没有测试。 */
export const SITE_PAGE_URLS: Record<string, string[]> = {
  boss: BOSS_PAGE_URLS,
  eleduck: ELEDUCK_PAGE_URLS,
  v2ex: V2EX_PAGE_URLS,
  mediastorm: MEDIASTORM_PAGE_URLS,
}

/**
 * 站点 id → 「这个地址上会不会展示某一个岗位」（适配器的 `isJobPage`）。
 *
 * 加站点时这里也要加一组：判错的代价是面板显示一个用户已经不在看的岗位，
 * 或者反过来在岗位页上什么都不显示，两种都只能靠用例钉住。
 *
 * ⚠ 几条边界，别把它们当成矛盾：
 *  1. **DOM 层面的内容判据不在本表里**：V2EX 里别的节点的主题页、电鸭里非招聘分类的
 *     帖子，地址上都是「有帖子的页面」（true），算不算岗位由各站点的 `isJobPostPage`
 *     决定。
 *  2. **本表的用例都在「页面上什么都没渲染」的前提下成立**（测试里就是这么跑的）。
 *     BOSS 的 `/job_detail…` 是个例外：它既可能是独立详情页，也可能是列表页的右侧
 *     面板，后者要页面渲染出来才算岗位页 —— 那一支见
 *     `boss/__tests__/jobPage.spec.ts`。
 */
export const JOB_PAGE_CASES: Record<string, Array<[string, boolean]>> = {
  boss: [
    /*
     * 独立职位详情页：**不算岗位页**（有意为之）。
     * 它的 DOM 与列表页那套详情面板不同，硬读出来的岗位名/公司名对不上真岗位 ——
     * 与其显示错的，不如让面板显示「还没有选中岗位」。
     */
    ['https://www.zhipin.com/job_detail/e2305163cf88e8420nN93NS0GFVT.html', false],
    // 老版搜索结果页形态（地址上带着 securityId）同样按详情页处理
    ['https://www.zhipin.com/job_detail/?securityId=abc123', false],
    // 同一个路径的裸形态（不带结尾斜杠）也不该漏
    ['https://www.zhipin.com/job_detail', false],
    // 列表 / 搜索页：右侧就是详情面板，用户点开卡片后岗位出现在那里
    ['https://www.zhipin.com/web/geek/jobs', true],
    ['https://www.zhipin.com/web/geek/job?query=Java&city=101020100', true],
    // 沟通页：用户在这里看的是会话，面板应该是「还没有选中岗位」
    ['https://www.zhipin.com/web/geek/chat', false],
    ['https://www.zhipin.com/web/geek/chat#/chat/123', false],
    ['https://www.zhipin.com/web/user/?ka=header-login', false],
    ['https://www.zhipin.com/gongsi/abc~.html', false],
  ],
  eleduck: [
    // 帖子页：地址上带着 slug
    ['https://eleduck.com/posts/z1fRK7', true],
    // 列表页：不展示某一个岗位
    ['https://eleduck.com/jobs-channel', false],
  ],
  v2ex: [
    ['https://www.v2ex.com/t/1245478', true],
    ['https://www.v2ex.com/t/1245478#reply3', true],
    // 酷工作节点页只有列表
    ['https://www.v2ex.com/go/jobs', false],
  ],
  mediastorm: [
    ['https://mediastorm.jobs.feishu.cn/index/position/7673106028406786331/detail', true],
    // 站内路由形态：同一个岗位，另一种路径
    ['https://mediastorm.jobs.feishu.cn/position/detail/7673106028406786331', true],
    // 职位列表页
    ['https://mediastorm.jobs.feishu.cn/index/position', false],
  ],
}

/** 地址不可解析的几种输入：任何站点都不该认成岗位页 */
export const JOB_PAGE_FALSE_URLS = ['about:blank', 'chrome://extensions', '', 'https://example.com/']

export const NON_SITE_URLS = [
  'https://example.com',
  // 后缀钓鱼：域名不是 zhipin.com，正则必须不认
  'https://zhipin.com.evil.com/web/geek/jobs',
  // 同理：eleduck.com 之外的都是别的站点
  'https://eleduck.com.evil.com/posts/z1fRK7',
  // 同理：v2ex.com / v2ex.co 之外的都是别的站点
  'https://v2ex.com.evil.com/t/1245478',
  'https://v2ex.co.evil.com/t/1245478',
  /*
   * 同理：飞书招聘上只认租户表里列出的那些子域。
   * 这两条是**有意**不认的 —— 放行它们等于申请一个能读该平台上所有公司招聘页的
   * 主机权限（见 sites/feishu/tenants.ts 文件头）。
   */
  'https://mediastorm.jobs.feishu.cn.evil.com/index/position/1/detail',
  'https://other.jobs.feishu.cn/index/position/7673106028406786331/detail',
  'https://www.liepin.com/',
  'https://www.51job.com/',
  // 浏览器内部页 / 扩展页
  'chrome://extensions',
  'about:blank',
  // 空值：标签页可能还没加载完，url 为空
  undefined,
  '',
]
