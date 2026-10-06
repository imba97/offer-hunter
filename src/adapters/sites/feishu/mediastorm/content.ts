import { createContentScript } from '../../content-script'
import mediastormSite from './index'

/**
 * 影视飓风内容脚本入口。
 *
 * 每个站点一个入口，正文却完全共用（见 sites/content-script.ts）；
 * 它的平台逻辑在上一层（`sites/feishu/`），这里看不出来也不需要看出来。
 */
createContentScript(mediastormSite)
