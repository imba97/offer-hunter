import { defineSiteMeta } from '../types'

/**
 * 电鸭社区的**纯数据描述**（理由同 boss/meta.ts：后台只需要这些数据）。
 */
export default defineSiteMeta({
  id: 'eleduck',
  label: '电鸭社区',
  /*
   * 只是**列表**地址：拿岗位内容仍然要到具体的帖子页（/posts/<slug>）。
   * 这一点已在侧边栏的空状态文案里说明（「先打开职位列表，再点开岗位」）。
   */
  jobsPageUrl: 'https://eleduck.com/jobs-channel',
  // 站点对非浏览器请求会返回验证页，因此没有可用的接口，只读 DOM
  source: 'dom',
  color: '#f9ba48',
  // 主色偏亮，用深色字才看得清
  textColor: '#3d2f0b',
  matches: ['*://*.eleduck.com/*'],
  hostnames: ['eleduck.com'],
})
