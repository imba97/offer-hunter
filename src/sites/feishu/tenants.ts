/**
 * 飞书招聘（飞书 ATS）平台的**租户表**。
 *
 * 飞书招聘是一套 SaaS：每家公司用同一个前端、同一套接口，只有子域与官网路径不同
 * （`<子域>.jobs.feishu.cn/<官网路径>/position/<岗位标识>/detail`）。因此「加一家
 * 公司」在代码上就是**在这里加一行 + 在本目录下建一个同名子目录**（入口文件）。
 *
 * 三件事都由这张表派生，所以不存在「改了这里忘了那里」：
 *  - `../site-descriptors.ts` 里的站点描述（主机权限、content_scripts、侧边栏按钮、配色）
 *  - `./site.ts` 生成的适配器实例（每个租户一份，账本按站点 id 分命名空间）
 *  - 各租户目录（`sites/feishu/<公司>/`）的内容脚本 / 注入脚本入口
 *
 * ⚠ 为什么是「一张表」而不是「放行整个 `*.jobs.feishu.cn`」：
 *   后者代码更少，但它等于申请一个能读该平台上**所有公司**招聘页的主机权限，
 *   与本项目「权限很窄」的边界冲突（见 docs/privacy-policy.md 第 5 节）。
 *   代价是每支持一家公司要加一行 —— 这是有意的取舍。
 */

export interface FeishuAtsTenant {
  /**
   * 站点标识，必须与**本目录下**的同名子目录一致（构建按目录约定产出脚本）：
   * `id: 'acme'` 对应 `sites/feishu/acme/`。
   *
   * 它同时是账本键的命名空间（`<siteId>:<naturalKey>`），所以**不要**在平台改名时
   * 跟着改它 —— 改了等于把用户已有的分析记录变成孤儿。
   */
  id: string
  /** 展示用名字（侧边栏按钮、诊断、提示文案里出现） */
  label: string
  /** 该公司在飞书招聘上的子域，形如 `mediastorm`（不含 `.jobs.feishu.cn`） */
  subdomain: string
  /**
   * 官网路径，即接口 `website-path` 头的值（影视飓风是 `index`）。
   * 也是职位页地址的第一段：`/<path>/position`。
   */
  path: string
  /**
   * 「打开职位页」按钮的目标与配色。
   *
   * 配色刻意逐租户声明：按钮上写的是**公司名**，用公司自己的品牌色才说得通
   * （平台自身的主题色是每个租户各自配的，主色也就各不相同）。
   */
  color: string
  textColor: string
}

/**
 * 已支持的租户。
 *
 * `path` / `color` 都取自真机或由用户指定，不是猜的；新增一家时同样应当从对方的
 * 招聘页上取，而不是随手填一个。
 *
 * 本表是每个租户各项数据的**唯一来源**：`site-descriptors.ts`（站点描述）与
 * `feishu/site.ts`（适配器实例）都从这里读，所以不存在「两处各写一份、改一处忘一处」。
 */
export const FEISHU_ATS_TENANTS: FeishuAtsTenant[] = [
  {
    id: 'mediastorm',
    label: '影视飓风',
    // 真机地址：https://mediastorm.jobs.feishu.cn/index/position/7673106028406786331/detail
    subdomain: 'mediastorm',
    path: 'index',
    /*
     * 影视飓风的品牌色（人工指定）：`#d8152a`。
     * 白色文字在其上的对比度约 5.0:1，正文级小字也够用。
     */
    color: '#d8152a',
    textColor: '#ffffff',
  },
]

/** 该租户的权威主机名（子域 + 平台域名） */
export function tenantHostname(tenant: FeishuAtsTenant): string {
  return `${tenant.subdomain}.jobs.feishu.cn`
}

/** 该租户的职位列表页地址（侧边栏按钮的目标） */
export function tenantJobsPageUrl(tenant: FeishuAtsTenant): string {
  return `https://${tenantHostname(tenant)}/${tenant.path}/position`
}

/** 按站点 id 取租户；未知 id 返回 undefined */
export function getFeishuAtsTenant(id: string): FeishuAtsTenant | undefined {
  return FEISHU_ATS_TENANTS.find(tenant => tenant.id === id)
}
