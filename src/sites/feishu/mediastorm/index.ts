import type { ApiJobSiteAdapter } from '../../types'
import { createFeishuAtsSite } from '../site'
import { getFeishuAtsTenant } from '../tenants'

/**
 * 影视飓风的适配器实例。
 *
 * 岗位页跑在飞书招聘上，所以平台逻辑全在上一层（`sites/feishu/`），这里只把
 * 该租户的配置交给租户特征层 —— 与其他站点适配器同形，注册表、内容脚本入口、
 * 测试都不需要知道「它其实是个租户」。
 *
 * ⚠ 站点 id 就是 `mediastorm`（与注册表、账本键、产物文件名一致）：账本键是
 *   `<siteId>:<naturalKey>`，改它等于把用户已有的分析记录变成孤儿。
 */
export const mediastormSite: ApiJobSiteAdapter = createFeishuAtsSite(
  // 配置缺失属于编码错误（目录名与租户表不一致），让它当场炸掉而不是静默跑一个空适配器
  getFeishuAtsTenant('mediastorm')!,
)
