import { createContentScript } from '../../content-script'
import { mediastormSite } from './index'

/**
 * 影视飓风内容脚本入口。
 *
 * 每个站点一个入口，正文却完全共用（见 sites/content-script.ts）；
 * 飞书招聘的各租户之间共用的是上一层（`sites/feishu/`）里的平台实现。
 */
createContentScript(mediastormSite)
