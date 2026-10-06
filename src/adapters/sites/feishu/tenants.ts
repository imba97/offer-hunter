import type { FeishuAtsSiteInput, FeishuAtsTenant } from './site'

/**
 * 飞书招聘（飞书 ATS）平台的**租户表**。
 *
 * 飞书招聘是一套 SaaS：每家公司用同一个前端、同一套接口，只有子域与官网路径不同
 * （`<子域>.jobs.feishu.cn/<官网路径>/position/<岗位标识>/detail`）。因此「加一家
 * 公司」在代码上就是三处各加一点：
 *
 *   1. `sites/feishu/<公司>/meta.ts`    站点描述（公司名、配色、匹配地址）
 *   2. `sites/feishu/<公司>/index.ts`   一行 `feishuAtsSite(meta, { subdomain, path })`
 *   3. 本文件的表里加一行（子域与官网路径）
 *
 * 本表存在的意义是「一个地方能看全已支持的雇主」：子域与官网路径是接口与地址的
 * 一部分，散在各站点目录里就没有这么一眼可见了。它与各站点的 meta 之间不会打架 ——
 * 两者的字段完全不重叠（meta 管展示与路由，本表管接口与地址）。
 *
 * ⚠ 为什么是「一张表」而不是「放行整个 `*.jobs.feishu.cn`」：
 *   后者代码更少，但它等于申请一个能读该平台上**所有公司**招聘页的主机权限，
 *   与本项目「权限很窄」的边界冲突（见 docs/privacy-policy.md 第 5 节）。
 *   代价是每支持一家公司要加一行 —— 这是有意的取舍。
 */
export interface FeishuAtsTenantEntry extends FeishuAtsSiteInput {
  /**
   * 站点标识，必须与 `sites/feishu/<id>/` 目录名一致（构建按目录约定产出脚本）。
   *
   * 它同时是账本键的命名空间（`<siteId>:<naturalKey>`），所以**不要**在平台改名时
   * 跟着改它 —— 改了等于把用户已有的分析记录变成孤儿。
   */
  id: string
}

/**
 * 已支持的租户。
 *
 * `subdomain` / `path` 都取自真机（对方招聘页的地址），不是猜的；新增一家时同样
 * 应当从对方的招聘页上取，而不是随手填一个。
 */
export const FEISHU_ATS_TENANTS: FeishuAtsTenantEntry[] = [
  {
    id: 'mediastorm',
    // 真机地址：https://mediastorm.jobs.feishu.cn/index/position/7673106028406786331/detail
    subdomain: 'mediastorm',
    path: 'index',
  },
]

/** 按站点 id 取租户；未知 id 返回 undefined */
export function getFeishuAtsTenant(id: string): FeishuAtsTenantEntry | undefined {
  return FEISHU_ATS_TENANTS.find(tenant => tenant.id === id)
}

export type { FeishuAtsTenant }
