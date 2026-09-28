import { describe, expect, it } from 'vitest'
import { bossSite } from '../boss'
import { contentScriptEntries, getJobSite, JOB_SITES } from '../registry'
import { detectSite, getSiteDescriptor, SITE_DESCRIPTORS, siteMatches, supportedSitesLabel } from '../routing'
import { BOSS_PAGE_URLS, NON_SITE_URLS } from './urlFixtures'

/**
 * 站点注册表与路由的测试。
 *
 * 与简历来源那份同构：钉住的是「新增站点只加 sites/<id>/ + 注册」这个不变量。
 *
 * 这里同时守住一条**架构边界**：路由（routing）不得依赖任何站点代码 ——
 * 后台 import 的是它，一旦它把适配器拖进来，后台包就会混入 DOM 代码。
 * 下面的断言是行为层面的（只看数据与结果），真正的体积验证靠构建产物。
 */

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
})

describe('适配器（JOB_SITES）', () => {
  it('每个站点都实现了全部契约方法', () => {
    for (const site of JOB_SITES) {
      const fns = [
        'matchUrl',
        'naturalKeyFromUrl',
        'viewFromApiPayload',
        'isDetailApiUrl',
        'fetchView',
        'probeDetail',
        'readJd',
        'jdProbeElement',
        'jdContainerElement',
        'buildDomFallback',
        'readOutline',
        'sameJob',
        'emptyRef',
        'diagnose',
      ] as const

      for (const fn of fns)
        expect(typeof site[fn], `${site.id}.${fn}`).toBe('function')

      // needsPageCookie 是布尔声明，不是函数；它决定要不要走内容脚本转发
      expect(typeof site.needsPageCookie).toBe('boolean')
    }
  })

  it('适配器声明与描述声明一致（否则 manifest 与运行时判断会打架）', () => {
    for (const site of JOB_SITES) {
      const descriptor = getSiteDescriptor(site.id)
      expect(descriptor, `缺少 ${site.id} 的站点描述`).toBeDefined()
      expect(site.manifest.matches).toEqual(descriptor!.matches)
      expect(site.jobsPageUrl).toBe(descriptor!.jobsPageUrl)
    }
  })

  it('每个站点都有内容脚本与注入脚本入口（构建按目录约定找它）', () => {
    const entries = contentScriptEntries()

    expect(entries.map(e => e.siteId).sort()).toEqual(JOB_SITES.map(s => s.id).sort())
    for (const entry of entries) {
      expect(entry.entry).toBe(`src/sites/${entry.siteId}/content.ts`)
      expect(entry.fileName).toBe(`${entry.siteId}.global.js`)
    }
  })

  it('emptyRef 造出的身份与该站点 id 一致（否则账本会记错站点）', () => {
    for (const site of JOB_SITES) {
      const ref = site.emptyRef('some-key')
      expect(ref.siteId).toBe(site.id)
      expect(ref.naturalKey).toBe('some-key')
    }
  })
})

describe('getJobSite / detectSite', () => {
  it('按 id 取站点', () => {
    expect(getJobSite('boss')).toBe(bossSite)
  })

  it('未知 id 返回 undefined', () => {
    expect(getJobSite('liepin')).toBeUndefined()
  })

  it('按 URL 认出站点（这是后台选标签页的唯一判据）', () => {
    for (const url of BOSS_PAGE_URLS)
      expect(detectSite(url)?.id, url).toBe('boss')
  })

  it('不属于任何站点的 URL 返回 null', () => {
    for (const url of NON_SITE_URLS)
      expect(detectSite(url), String(url)).toBeNull()
  })

  it('适配器的 matchUrl 与路由判定一致（不是两份实现）', () => {
    for (const url of [...BOSS_PAGE_URLS, ...NON_SITE_URLS]) {
      expect(bossSite.matchUrl(url), String(url))
        .toBe(detectSite(url)?.id === 'boss')
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
