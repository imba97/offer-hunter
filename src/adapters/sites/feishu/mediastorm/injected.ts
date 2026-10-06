import { installInjectedCapture } from '../../injected'
import mediastormSite from './index'

/**
 * 影视飓风 MAIN world 注入脚本入口。
 *
 * 飞书招聘有接口要捕获（岗位详情是公开 JSON 接口），因此有这一份脚本，
 * manifest 也会把它按 `world: 'MAIN'` 注入（见 src/manifest.ts）。
 * 监听哪条路径由适配器声明，这里不写死。
 */
installInjectedCapture({
  watchedApiPaths: mediastormSite.manifest.watchedApiPaths,
})
