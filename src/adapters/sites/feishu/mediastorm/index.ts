import { feishuAtsSite } from '../site'
import meta from './meta'

/**
 * 影视飓风适配器。
 *
 * 岗位页跑在飞书招聘上，所以平台逻辑全在上一层（`sites/feishu/`）；这里只声明
 * 「这家公司在平台上的位置」。与其他站点目录同形：一个 meta.ts + 一个 index.ts，
 * 注册表按目录约定 glob 后者。
 *
 * 将来加一家公司，这个文件就是模板（改 meta 与下面两个值）。
 */
export default feishuAtsSite(meta, {
  subdomain: 'mediastorm',
  path: 'index',
})
