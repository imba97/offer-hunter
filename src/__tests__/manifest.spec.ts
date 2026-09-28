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

  it('每个站点都有 MAIN world 与 ISOLATED world 两份脚本，且顺序正确', async () => {
    const manifest = await getManifest()
    const scripts = manifest.content_scripts ?? []

    // 每个站点两条
    expect(scripts).toHaveLength(SITE_DESCRIPTORS.length * 2)

    for (const [index, site] of SITE_DESCRIPTORS.entries()) {
      const main = scripts[index * 2]
      const isolated = scripts[index * 2 + 1]

      // MAIN world 必须排在前面：注在 document_start，否则漏掉首屏请求
      expect(main.matches).toEqual(site.matches)
      expect(main.js).toEqual([`dist/injected/${site.id}.js`])
      expect(main.run_at).toBe('document_start')
      expect(main.world).toBe('MAIN')

      expect(isolated.matches).toEqual(site.matches)
      expect(isolated.js).toEqual([`dist/contentScripts/${site.id}.global.js`])
      expect(isolated.run_at).toBe('document_idle')
      // 隔离世界不该声明 world（默认 ISOLATED）
      expect(isolated.world).toBeUndefined()
    }
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
})
