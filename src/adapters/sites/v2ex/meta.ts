import { defineSiteMeta } from '../types'

/**
 * V2EX 的**纯数据描述**（理由同 boss/meta.ts：后台只需要这些数据）。
 */
export default defineSiteMeta({
  id: 'v2ex',
  label: 'V2EX',
  /*
   * 「酷工作」节点页。只是**列表**地址：拿岗位内容要到具体的帖子页
   * （/t/<id>），且只认发在这个节点下的帖子。
   */
  jobsPageUrl: 'https://www.v2ex.com/go/jobs',
  // 帖子正文由服务端直接渲染进 HTML，页面自己不调详情接口，因此只读 DOM
  source: 'dom',
  /*
   * V2EX 的「灰蓝」主色（人工选定，不取自站内色板）：V2EX 自身没有品牌蓝，
   * 全站唯一的贯穿色是站点头部那条 #778087，而它偏浅、当按钮底色不够沉。
   * 取更深的 #444455，白色文字在其上的对比度约 9.2:1。
   */
  color: '#444455',
  textColor: '#ffffff',
  /*
   * 两个域名族：v2ex.com 是主站（含 www），v2ex.co 是官方备用域名
   * （搜索结果与部分地区的跳转都落在 global.v2ex.co）。
   */
  matches: ['*://*.v2ex.com/*', '*://*.v2ex.co/*'],
  hostnames: ['v2ex.com', 'v2ex.co'],
})
