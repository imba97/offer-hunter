import { createContentScript } from '../content-script'
import { eleduckSite } from './index'

/**
 * 电鸭社区内容脚本入口。
 *
 * 每个站点一个入口，正文却完全共用（见 sites/content-script.ts）。
 * 这个站点只有这一份脚本：它没有接口要捕获，因此没有 injected.ts
 * （manifest 也不会引用一个不存在的产物）。
 */
createContentScript(eleduckSite)
