import { describe, expect, it } from 'vitest'
import { bossSite } from '../boss'
import { eleduckSite } from '../eleduck'
import { contentScriptEntries, getJobSite, JOB_SITES } from '../registry'
import { detectSite, getSiteDescriptor, SITE_DESCRIPTORS, siteMatches, supportedSitesLabel } from '../routing'
import { v2exSite } from '../v2ex'
import { NON_SITE_URLS, SITE_PAGE_URLS } from './urlFixtures'

/**
 * 站点注册表与路由的测试。
 *
 * 与简历来源那份同构：钉住的是「新增站点只加 sites/<id>/ + 注册」这个不变量。
 *
 * 这里同时守住一条**架构边界**：路由（routing）不得依赖任何站点代码 ——
 * 后台 import 的是它，一旦它把适配器拖进来，后台包就会混入 DOM 代码。
 * 下面的断言是行为层面的（只看数据与结果），真正的体积验证靠构建产物。
 */

/**
 * 站点目录里实际存在的入口文件。
 *
 * 用 Vite 的 glob 而不是 fs + 相对路径：测出来的就是**构建脚本看到的同一份事实**
 * （scripts/build-sites.ts 也按目录约定发现站点），且不必猜测试进程的 cwd。
 */
const CONTENT_ENTRIES = Object.keys(import.meta.glob('../*/content.ts'))
const INJECTED_ENTRIES = Object.keys(import.meta.glob('../*/injected.ts'))

describe('站点描述（SITE_DESCRIPTORS）', () => {
  it('id 唯一，且与适配器注册表的 id 一一对应', () => {
    const descriptorIds = SITE_DESCRIPTORS.map(site => site.id)
    expect(new Set(descriptorIds).size).toBe(descriptorIds.length)
    // 描述与适配器必须是同一批站点，缺一边会表现成「后台认它、内容脚本没实现」
    expect(descriptorIds.sort()).toEqual(JOB_SITES.map(site => site.id).sort())
  })

  it('每项都声明了名字 / 职位页 / 匹配模式 / 主机名', () => {
    for (const site of SITE_DESCRIPTORS) {
      expect(site.label.length).toBeGreaterThan(0)
      expect(site.jobsPageUrl).toMatch(/^https:\/\//)
      expect(site.matches.length).toBeGreaterThan(0)
      expect(site.hostnames.length).toBeGreaterThan(0)
    }
  })

  it('每项都有配色（按钮背景 + 其上的文字色）', () => {
    for (const site of SITE_DESCRIPTORS) {
      // 侧边栏的空状态直接把它们塞进内联 style，格式不对不会报错、只会渲染成透明
      expect(site.color, site.id).toMatch(/^#[0-9a-f]{6}$/i)
      expect(site.textColor, site.id).toMatch(/^#[0-9a-f]{6}$/i)
      // 同一个颜色当背景又当文字色 = 看不见
      expect(site.textColor.toLowerCase(), site.id).not.toBe(site.color.toLowerCase())
    }
  })
})

describe('适配器（JOB_SITES）', () => {
  it('每个站点都实现了全部契约方法', () => {
    /** 与取数方式无关的公共方法 */
    const common = [
      'matchUrl',
      'naturalKeyFromUrl',
      'readJd',
      'jdProbeElement',
      'jdContainerElement',
      'buildDomFallback',
      'readOutline',
      'sameJob',
      'emptyRef',
      'diagnose',
    ] as const

    /** 只有有接口的站点才需要实现 */
    const apiOnly = [
      'viewFromApiPayload',
      'isDetailApiUrl',
      'fetchView',
      'probeDetail',
    ] as const

    for (const site of JOB_SITES) {
      const methods = site as unknown as Record<string, unknown>
      for (const fn of common)
        expect(typeof methods[fn], `${site.id}.${fn}`).toBe('function')

      for (const fn of apiOnly) {
        const actual = typeof methods[fn]
        expect(actual, `${site.id}.${fn}`).toBe(site.source === 'api' ? 'function' : 'undefined')
      }
    }
  })

  it('适配器声明与描述声明一致（否则 manifest 与运行时判断会打架）', () => {
    for (const site of JOB_SITES) {
      const descriptor = getSiteDescriptor(site.id)
      expect(descriptor, `缺少 ${site.id} 的站点描述`).toBeDefined()
      expect(site.manifest.matches).toEqual(descriptor!.matches)
      expect(site.jobsPageUrl).toBe(descriptor!.jobsPageUrl)
      // source 决定 manifest 要不要注入 MAIN world 脚本，两处必须同源
      expect(site.source, site.id).toBe(descriptor!.source)
    }
  })

  it('source 与 watchedApiPaths 互相印证（声明了接口就得真的监听一个路径）', () => {
    for (const site of JOB_SITES) {
      const watches = site.manifest.watchedApiPaths.length > 0
      expect(watches, `${site.id} 的 source=${site.source} 与 watchedApiPaths 不一致`)
        .toBe(site.source === 'api')
    }
  })

  it('每个站点都有内容脚本入口，且只有有接口的站点才有注入脚本入口', () => {
    const entries = contentScriptEntries()

    expect(entries.map(e => e.siteId).sort()).toEqual(JOB_SITES.map(s => s.id).sort())
    for (const entry of entries) {
      expect(entry.entry).toBe(`src/sites/${entry.siteId}/content.ts`)
      expect(entry.fileName).toBe(`${entry.siteId}.global.js`)
    }

    /*
     * manifest 只引用真实存在的产物：DOM-only 站点声明了 dist/injected/<id>.js
     * 而构建不会生成它的话，扩展会直接装不上（"Could not load javascript"）。
     * 构建脚本按「目录下有没有 injected.ts」发现站点，所以这里就查这个文件。
     */
    for (const site of JOB_SITES) {
      expect(CONTENT_ENTRIES, site.id).toContain(`../${site.id}/content.ts`)
      const hasInjected = INJECTED_ENTRIES.includes(`../${site.id}/injected.ts`)
      expect(hasInjected, `${site.id} 的 source=${site.source} 与注入脚本入口不一致`)
        .toBe(site.source === 'api')
    }
  })

  it('emptyRef 造出的身份与该站点 id 一致（否则账本会记错站点）', () => {
    for (const site of JOB_SITES) {
      const ref = site.emptyRef('some-key')
      expect(ref.siteId).toBe(site.id)
      /*
       * 传进去的 key 是「取数凭据」，不等于身份：BOSS 的 securityId 每次访问都新签，
       * 拿它当身份会让同一个岗位每刷新一次就换个账本键（真机症状见 boss/__tests__/identity.spec.ts）。
       * 所以只要求它**落在这份 ref 里**（哪里都行），不要求它一定占着 naturalKey。
       */
      const carried = ref.naturalKey === 'some-key'
        || Object.values(ref.ids ?? {}).includes('some-key')
      expect(carried, `${site.id} 的 emptyRef 把 key 丢了`).toBe(true)
    }
  })
})

describe('getJobSite / detectSite', () => {
  it('按 id 取站点', () => {
    expect(getJobSite('boss')).toBe(bossSite)
    expect(getJobSite('eleduck')).toBe(eleduckSite)
    expect(getJobSite('v2ex')).toBe(v2exSite)
  })

  it('未知 id 返回 undefined', () => {
    expect(getJobSite('liepin')).toBeUndefined()
  })

  it('按 URL 认出站点（这是后台选标签页的唯一判据）', () => {
    for (const site of SITE_DESCRIPTORS) {
      const urls = SITE_PAGE_URLS[site.id] ?? []
      // 每个站点都必须有一组地址用例，否则「认不认得出」这件事根本没被测
      expect(urls.length, `缺少 ${site.id} 的地址用例`).toBeGreaterThan(0)
      for (const url of urls)
        expect(detectSite(url)?.id, url).toBe(site.id)
    }
  })

  it('不属于任何站点的 URL 返回 null', () => {
    for (const url of NON_SITE_URLS)
      expect(detectSite(url), String(url)).toBeNull()
  })

  it('适配器的 matchUrl 与路由判定一致（不是两份实现）', () => {
    const allUrls = [...Object.values(SITE_PAGE_URLS).flat(), ...NON_SITE_URLS]

    for (const site of JOB_SITES) {
      for (const url of allUrls) {
        expect(site.matchUrl(url), `${site.id} @ ${String(url)}`)
          .toBe(detectSite(url)?.id === site.id)
      }
    }
  })
})

describe('siteMatches / supportedSitesLabel', () => {
  it('host_permissions 用的模式来自站点描述', () => {
    expect(siteMatches()).toEqual(SITE_DESCRIPTORS.flatMap(site => site.matches))
  })

  it('模式都是合法的 match pattern（否则扩展会装不上）', () => {
    for (const pattern of siteMatches())
      expect(pattern).toMatch(/^\*:\/\/[^/]+\/\*$/)
  })

  it('提示文案由站点名拼出，不写死', () => {
    expect(supportedSitesLabel()).toBe(SITE_DESCRIPTORS.map(site => site.label).join(' / '))
  })
})
