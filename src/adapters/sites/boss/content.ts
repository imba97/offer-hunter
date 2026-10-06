import { createContentScript } from '../content-script'
import bossSite from './index'

/**
 * BOSS 直聘内容脚本入口。
 *
 * 每个站点一个入口，正文却完全共用（见 sites/content-script.ts）——
 * 新增站点就是再写一个这样的三行文件。
 *
 * 单独打包的理由：注入脚本捕获哪些接口由 manifest 静态决定，各站点的选择器
 * 也不会互相污染；新增站点不改变既有站点的产物。
 */
createContentScript(bossSite)
