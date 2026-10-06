import type { JobSiteAdapter } from '../types'
import { describe, expect, it } from 'vitest'
import bossSite from '../boss'
import eleduckSite from '../eleduck'
import mediastormSite from '../feishu/mediastorm'
import { contentScriptEntries, getJobSite, JOB_SITES } from '../registry'
import { detectSite, getSiteDescriptor, SITE_DESCRIPTORS, siteMatches, supportedSitesLabel } from '../routing'
import { siteIdFromPath } from '../site-entry'
import v2exSite from '../v2ex'
import { JOB_PAGE_CASES, JOB_PAGE_FALSE_URLS, NON_SITE_URLS, SITE_PAGE_URLS } from './urlFixtures'

/**
 * 站点注册表与路由的测试。
 *
 * 钉住的是**自动索引这条约定**：
 *  - `sites/<id>/meta.ts` 会被 routing 收进 SITE_DESCRIPTORS（纯数据）
 *  - `sites/<id>/index.ts` 会被 registry 收进 JOB_SITES（完整适配器）
 *  - 两者描述同一个站点（id 一致），且 `index.ts` 带上了它自己那份 meta
 *  - 每个站点目录都有 `content.ts`（有接口的还有 `injected.ts`）
 *
 * 这里同时守住一条**架构边界**：路由（routing）不得依赖任何站点代码 ——
 * 后台 import 的是它，一旦它把适配器拖进来，后台包就会混入 DOM 代码。
 * 下面的断言是行为层面的（只看数据与结果），真正的体积验证靠构建产物。
 */

/**
 * 站点目录里实际存在的文件。
 *
 * 用 Vite 的 glob 而不是 fs + 相对路径：测出来的就是**构建脚本看到的同一份事实**
 * （scripts/build-sites.ts 也按目录约定发现站点），且不必猜测试进程的 cwd。
 *
 * ⚠ 用 `**` 而不是 `*`：站点目录可以嵌在平台目录下（`../feishu/mediastorm/content.ts`），
 *   `*` 看不到它们。站点 id 取**叶子目录名**（与构建脚本、site-entry.ts 同一套规则）。
 */
const META_ENTRIES = Object.keys(import.meta.glob('../**/meta.ts'))
const ADAPTER_ENTRIES = Object.keys(import.meta.glob('../**/index.ts'))
const CONTENT_ENTRIES = Object.keys(import.meta.glob('../**/content.ts'))
const INJECTED_ENTRIES = Object.keys(import.meta.glob('../**/injected.ts'))

/** `../feishu/mediastorm/index.ts` → `mediastorm`（与 site-entry.ts 的 siteIdFromPath 同一规则） */
function idOf(globKey: string): string {
  return siteIdFromPath(globKey)
}

describe('自动索引（glob 约定）', () => {
  it('每个站点目录都有 meta.ts 与 index.ts，且被两个注册表都收到', () => {
    // 三个清单必须一一对应：少一个就会表现成「后台认这个站点、内容脚本没实现」之类
    const metaIds = META_ENTRIES.map(idOf).sort()
    const adapterIds = ADAPTER_ENTRIES.map(idOf).sort()

    expect(metaIds.length).toBeGreaterThan(0)
    expect(metaIds).toEqual(adapterIds)

    // 索引出来的就是全部站点，没有漏（例如目录名写错、文件没默认导出）
    expect(SITE_DESCRIPTORS.map(site => site.id).sort()).toEqual(metaIds)
    expect(JOB_SITES.map(site => site.meta.id).sort()).toEqual(adapterIds)
  })

  it('适配器带的 meta 与路由索引到的那份是同一个对象', () => {
    for (const site of JOB_SITES) {
      const descriptor = getSiteDescriptor(site.meta.id)
      expect(descriptor, `缺少 ${site.meta.id} 的 meta.ts`).toBeDefined()
      // 同一个对象：defineSite 只是把传进来的 meta 原样带上，没有再复制一份
      expect(site.meta, site.meta.id).toBe(descriptor)
    }
  })
})

describe('站点描述（meta.ts）', () => {
  it('id 唯一', () => {
    const ids = SITE_DESCRIPTORS.map(site => site.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每项都声明了名字 / 职位页 / 匹配模式 / 主机名 / 取数方式', () => {
    for (const site of SITE_DESCRIPTORS) {
      expect(site.label.length).toBeGreaterThan(0)
      expect(site.jobsPageUrl).toMatch(/^https:\/\//)
      expect(site.matches.length).toBeGreaterThan(0)
      expect(site.hostnames.length).toBeGreaterThan(0)
      expect(['api', 'dom']).toContain(site.source)
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
      'isJobPage',
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
        expect(typeof methods[fn], `${site.meta.id}.${fn}`).toBe('function')

      for (const fn of apiOnly) {
        const actual = typeof methods[fn]
        expect(actual, `${site.meta.id}.${fn}`).toBe(site.meta.source === 'api' ? 'function' : 'undefined')
      }
    }
  })

  it('manifest 的 matches 就是 meta 的 matches（不是两份实现）', () => {
    for (const site of JOB_SITES)
      expect(site.manifest.matches, site.meta.id).toEqual(site.meta.matches)
  })

  it('source 与 watchedApiPaths 互相印证（声明了接口就得真的监听一个路径）', () => {
    for (const site of JOB_SITES) {
      const watches = site.manifest.watchedApiPaths.length > 0
      expect(watches, `${site.meta.id} 的 source=${site.meta.source} 与 watchedApiPaths 不一致`)
        .toBe(site.meta.source === 'api')
    }
  })

  it('每个站点都有内容脚本入口，且只有有接口的站点才有注入脚本入口', () => {
    const entries = contentScriptEntries()

    expect(entries.map(e => e.siteId).sort()).toEqual(JOB_SITES.map(s => s.meta.id).sort())
    for (const entry of entries) {
      expect(entry.fileName).toBe(`${entry.siteId}.global.js`)
      expect(entry.entry).toMatch(/^src\/adapters\/sites\/.+\/content\.ts$/)
      expect(entry.entry.endsWith(`/${entry.siteId}/content.ts`), entry.entry).toBe(true)
    }

    /*
     * manifest 只引用真实存在的产物：DOM-only 站点声明了 dist/injected/<id>.js
     * 而构建不会生成它的话，扩展会直接装不上（"Could not load javascript"）。
     * 构建脚本按「目录下有没有 injected.ts」发现站点，所以这里就查这个文件。
     */
    const entryOf = new Map(entries.map(e => [e.siteId, e.entry]))

    for (const site of JOB_SITES) {
      const entry = entryOf.get(site.meta.id)
      expect(entry, `${site.meta.id} 没有内容脚本入口`).toBeDefined()

      // 入口相对 adapters/sites 的路径 → vitest 里 import.meta.glob 的键（`../...`）
      const relative = entry!.replace(/^src\/adapters\/sites\//, '../')
      expect(CONTENT_ENTRIES, site.meta.id).toContain(relative)

      const injectedEntry = relative.replace(/\/content\.ts$/, '/injected.ts')
      const hasInjected = INJECTED_ENTRIES.includes(injectedEntry)
      expect(hasInjected, `${site.meta.id} 的 source=${site.meta.source} 与注入脚本入口不一致`)
        .toBe(site.meta.source === 'api')
    }
  })

  it('emptyRef 造出的身份与该站点 id 一致（否则账本会记错站点）', () => {
    for (const site of JOB_SITES) {
      const ref = site.emptyRef('some-key')
      expect(ref.siteId).toBe(site.meta.id)
      /*
       * 传进去的 key 是「取数凭据」，不等于身份：BOSS 的 securityId 每次访问都新签，
       * 拿它当身份会让同一个岗位每刷新一次就换个账本键（真机症状见 boss/__tests__/identity.spec.ts）。
       * 所以只要求它**落在这份 ref 里**（哪里都行），不要求它一定占着 naturalKey。
       */
      const carried = ref.naturalKey === 'some-key'
        || Object.values(ref.ids ?? {}).includes('some-key')
      expect(carried, `${site.meta.id} 的 emptyRef 把 key 丢了`).toBe(true)
    }
  })
})

describe('getJobSite / detectSite', () => {
  it('按 id 取站点', () => {
    expect(getJobSite('boss')).toBe(bossSite)
    expect(getJobSite('eleduck')).toBe(eleduckSite)
    expect(getJobSite('v2ex')).toBe(v2exSite)
    // 飞书招聘的租户与普通站点完全同形，看不出它是从平台工厂出来的
    expect(getJobSite('mediastorm')).toBe(mediastormSite)
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
        expect(site.matchUrl(url), `${site.meta.id} @ ${String(url)}`)
          .toBe(detectSite(url)?.id === site.meta.id)
      }
    }
  })

  /**
   * 岗位页判定（`isJobPage`）。
   *
   * 内容脚本靠它把「当前岗位」绑在产生它的那一页上：地址离开岗位页就清掉岗位。
   * 因此判错有两个方向，都必须在用例里钉住 —— 尤其是**非岗位页要判 false**，
   * 那正是「切到沟通页，面板还显示最后一个岗位」的成因。
   */
  it('每个站点都声明了哪些地址会展示岗位', () => {
    for (const site of JOB_SITES) {
      const cases = JOB_PAGE_CASES[site.meta.id] ?? []
      // 每个站点都必须有一组用例，否则这条不变量根本没被测
      expect(cases.length, `缺少 ${site.meta.id} 的岗位页用例`).toBeGreaterThan(0)

      for (const [url, expected] of cases)
        expect(site.isJobPage(url), `${site.meta.id} @ ${url}`).toBe(expected)

      for (const url of JOB_PAGE_FALSE_URLS)
        expect(site.isJobPage(url), `${site.meta.id} @ ${url}`).toBe(false)
    }
  })

  it('岗位页用例里的地址都得先属于该站点（否则测的是别的站点的判定）', () => {
    for (const [siteId, cases] of Object.entries(JOB_PAGE_CASES)) {
      for (const [url] of cases)
        expect(detectSite(url)?.id, `${siteId} @ ${url}`).toBe(siteId)
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

/** 导出形状：内容脚本入口按默认导出一个适配器（registry 的 glob 依赖它） */
describe('适配器的模块形状', () => {
  it('每个站点目录的 index.ts 默认导出的是一个适配器', () => {
    for (const site of JOB_SITES as JobSiteAdapter[]) {
      expect(typeof site.matchUrl, site.meta.id).toBe('function')
      expect(typeof site.diagnose, site.meta.id).toBe('function')
    }
  })
})
