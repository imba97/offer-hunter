import { defineSiteMeta } from '../../types'

/**
 * 影视飓风的**纯数据描述**。
 *
 * 它的招聘页跑在飞书招聘（ATS）上，因此主机名是**租户子域**而不是自家域名。
 * 刻意只认这一个子域，不放行整个 `*.jobs.feishu.cn` —— 那等于申请一个能读该平台
 * 上所有公司招聘页的主机权限（理由见 feishu/tenants.ts 的文件头）。
 */
export default defineSiteMeta({
  id: 'mediastorm',
  label: '影视飓风',
  /*
   * 社招官网的职位列表页。与电鸭 / V2EX 一样，这里只是**列表**地址：
   * 拿岗位内容要到具体的详情页（`/index/position/<id>/detail`）。
   */
  jobsPageUrl: 'https://mediastorm.jobs.feishu.cn/index/position',
  // 岗位详情有一份公开 JSON 接口（注入脚本被动捕获 + 内容脚本主动补拉）
  source: 'api',
  /*
   * 影视飓风的品牌色（人工指定）：`#d8152a`。
   * 白色文字在其上的对比度约 5.0:1，正文级小字也够用。
   */
  color: '#d8152a',
  textColor: '#ffffff',
  matches: ['*://mediastorm.jobs.feishu.cn/*'],
  hostnames: ['mediastorm.jobs.feishu.cn'],
})
