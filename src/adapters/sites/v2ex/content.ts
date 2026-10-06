import { createContentScript } from '../content-script'
import v2exSite from './index'

/**
 * V2EX内容脚本入口。
 *
 * 每个站点一个入口，正文却完全共用（见 sites/content-script.ts）——
 * 新增站点就是再写一个这样的三行文件。
 */
createContentScript(v2exSite)
