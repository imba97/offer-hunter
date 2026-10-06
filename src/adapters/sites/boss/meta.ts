import { defineSiteMeta } from '../types'

/**
 * BOSS 直聘的**纯数据描述**。
 *
 * 与适配器（index.ts）分开是为了后台包：service worker 只需要这些数据来判断
 * 标签页属于哪个站点，不需要任何选择器与 DOM 代码（见 sites/types.ts 的说明）。
 */
export default defineSiteMeta({
  id: 'boss',
  label: 'BOSS 直聘',
  jobsPageUrl: 'https://www.zhipin.com/web/geek/jobs',
  // 岗位数据来自 /wapi/zpgeek/… 接口（注入脚本被动捕获）
  source: 'api',
  color: '#00bebd',
  textColor: '#ffffff',
  matches: ['*://*.zhipin.com/*'],
  hostnames: ['zhipin.com'],
})
