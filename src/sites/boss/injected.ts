import { installInjectedCapture } from '../injected'
import { bossSite } from './index'

/**
 * BOSS 直聘的 MAIN world 注入脚本入口。
 *
 * 每个站点一份，但正文完全共用（见 sites/injected.ts）——它只需要知道
 * 「本站点要被动捕获哪些接口」，那个信息来自适配器的 manifest 声明。
 *
 * ⚠ 这个文件会被打包成**自包含 IIFE**：manifest 里 world:"MAIN" 的注入只接受
 * 普通脚本，因此 vite.config.injected.mts 用 formats:['iife'] 把 import 全部内联。
 */
installInjectedCapture({
  watchedApiPaths: bossSite.manifest.watchedApiPaths,
})
