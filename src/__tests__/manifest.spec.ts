import { describe, expect, it } from 'vitest'
import { getManifest } from '../manifest'
import { SITE_DESCRIPTORS, siteMatches } from '../sites/routing'

/**
 * manifest 生成测试。
 *
 * 这一支钉住的是「加站点不用改 manifest.ts」：主机权限与 content_scripts
 * 必须完全由站点描述派生。真要验证的是**派生关系**（而不是某几个字面量），
 * 所以断言写成「与描述对齐」的形式。
 */
describe('manifest 由站点描述生成', () => {
  it('host_permissions 就是各站点声明的匹配模式（不写死域名）', async () => {
    const manifest = await getManifest()

    expect(manifest.host_permissions).toEqual(siteMatches())
    // 没有多余的宽权限：只申请各站点自己声明的那些
    expect(manifest.host_permissions).toHaveLength(SITE_DESCRIPTORS.flatMap(s => s.matches).length)
  })

  it('有接口的站点两份脚本（MAIN 在前），只读 DOM 的站点只要一份', async () => {
    const manifest = await getManifest()
    const scripts = manifest.content_scripts ?? []

    // 每个站点至少一条（隔离世界），有接口的再加一条 MAIN world
    const expected = SITE_DESCRIPTORS.reduce((n, site) => n + (site.source === 'api' ? 2 : 1), 0)
    expect(scripts).toHaveLength(expected)

    let index = 0
    for (const site of SITE_DESCRIPTORS) {
      if (site.source === 'api') {
        const main = scripts[index++]
        // MAIN world 必须排在前面：注在 document_start，否则漏掉首屏请求
        expect(main.matches).toEqual(site.matches)
        expect(main.js).toEqual([`dist/injected/${site.id}.js`])
        expect(main.run_at).toBe('document_start')
        expect(main.world).toBe('MAIN')
      }

      const isolated = scripts[index++]
      expect(isolated.matches).toEqual(site.matches)
      expect(isolated.js).toEqual([`dist/contentScripts/${site.id}.global.js`])
      expect(isolated.run_at).toBe('document_idle')
      // 隔离世界不该声明 world（默认 ISOLATED）
      expect(isolated.world).toBeUndefined()
    }
  })

  it('dOM-only 站点不会被注入 MAIN world 脚本（没有接口要捕获，挂了就是纯侵入）', async () => {
    const manifest = await getManifest()
    const injected = (manifest.content_scripts ?? []).filter(entry => entry.world === 'MAIN')

    expect(injected.map(entry => entry.js?.[0]).sort())
      .toEqual(SITE_DESCRIPTORS.filter(site => site.source === 'api').map(site => `dist/injected/${site.id}.js`).sort())
  })

  it('产物路径与构建配置的命名约定一致（写错了扩展会静默不注入）', async () => {
    const manifest = await getManifest()
    const scripts = manifest.content_scripts ?? []

    for (const entry of scripts) {
      for (const file of entry.js ?? []) {
        // vite.config.content.mts: contentScripts/<id>.global.js
        // vite.config.injected.mts: injected/<id>.js
        expect(file).toMatch(/^dist\/(injected\/[a-z0-9-]+\.js|contentScripts\/[a-z0-9-]+\.global\.js)$/)
      }
    }
  })

  it('不声明 web_accessible_resources（内容脚本不再渲染界面资源）', async () => {
    const manifest = await getManifest()

    // 少一处可被页面探测的指纹
    expect(manifest.web_accessible_resources).toBeUndefined()
  })

  it('chrome 产物不含 background.scripts（那是 MV2 的键，Chrome 会报噪音警告）', async () => {
    const manifest = await getManifest()

    /*
     * 真实症状：扩展管理页里出现
     * 「'background.scripts' requires manifest version of 2 or lower」。
     * 它不影响运行，但用户排障时第一眼看到的就是这条假警报 —— 所以两个键
     * 必须按浏览器互斥地给（Chrome 只给 service_worker）。
     *
     * ⚠ 单测里没有 EXTENSION=firefox，因此这里校验的就是 Chrome 产物。
     *   Firefox 那份由 `pnpm build:firefox` 走同一个分支判断生成。
     */
    expect(manifest.background).toEqual({ service_worker: 'dist/background/index.mjs' })
    expect(manifest.background).not.toHaveProperty('scripts')
  })
})
