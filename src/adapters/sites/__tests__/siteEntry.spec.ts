import { describe, expect, it } from 'vitest'
import {
  assertUniqueSiteIds,
  siteContentEntryOf,
  siteIdFromPath,
  siteInjectedEntryOf,
  siteRelativePath,
} from '../site-entry'

/**
 * 目录约定解析的单测。
 *
 * 这一小撮函数此前在三处各写了一遍（注册表、manifest 生成器、测试），而它们写歪的
 * 症状是**静默**的：某个站点不被索引、或产物路径对不上导致脚本注不进去。
 * 收敛成一份之后，这里把边界一次钉死。
 */

describe('siteIdFromPath', () => {
  it('取叶子目录名（平台下的租户也一样）', () => {
    expect(siteIdFromPath('./boss/index.ts')).toBe('boss')
    expect(siteIdFromPath('boss/meta.ts')).toBe('boss')
    expect(siteIdFromPath('./feishu/mediastorm/index.ts')).toBe('mediastorm')
    expect(siteIdFromPath('feishu/mediastorm/content.ts')).toBe('mediastorm')
    expect(siteIdFromPath('src/adapters/sites/mediastorm/injected.ts')).toBe('mediastorm')
  })

  it('不认的文件名返回空串（不猜一个站点出来）', () => {
    // 站点目录里的实现文件不参与目录约定，拿它们推 id 会推出一个不存在的站点
    expect(siteIdFromPath('./boss/selectors.ts')).toBe('')
    expect(siteIdFromPath('./boss/api.ts')).toBe('')
    expect(siteIdFromPath('./boss')).toBe('')
  })
})

describe('siteRelativePath', () => {
  it('去掉 glob 键的前导 ./', () => {
    expect(siteRelativePath('./feishu/mediastorm/content.ts')).toBe('feishu/mediastorm/content.ts')
    expect(siteRelativePath('boss/index.ts')).toBe('boss/index.ts')
  })
})

describe('入口表', () => {
  it('内容脚本入口按站点 id 建表，路径相对 src/sites', () => {
    const entries = siteContentEntryOf([
      './boss/content.ts',
      './feishu/mediastorm/content.ts',
      './boss/meta.ts',
      './boss/injected.ts',
    ])

    expect([...entries.entries()].sort()).toEqual([
      ['boss', 'src/adapters/sites/boss/content.ts'],
      ['mediastorm', 'src/adapters/sites/feishu/mediastorm/content.ts'],
    ])
  })

  it('注入脚本入口只收有 injected.ts 的站点', () => {
    const entries = siteInjectedEntryOf([
      './boss/injected.ts',
      './feishu/mediastorm/injected.ts',
      './eleduck/content.ts',
    ])

    expect([...entries.keys()].sort()).toEqual(['boss', 'mediastorm'])
    expect(entries.get('mediastorm')).toBe('src/adapters/sites/feishu/mediastorm/injected.ts')
  })

  it('空输入给空表（不抛错）', () => {
    expect(siteContentEntryOf([]).size).toBe(0)
    expect(siteInjectedEntryOf([]).size).toBe(0)
  })
})

describe('assertUniqueSiteIds', () => {
  const meta = (id: string) => ({ id }) as never

  it('id 唯一时通过', () => {
    expect(() => assertUniqueSiteIds([meta('boss'), meta('v2ex')])).not.toThrow()
  })

  it('id 重复时抛错并指出是哪个（否则按 id 查表会静默取到前一个）', () => {
    expect(() => assertUniqueSiteIds([meta('boss'), meta('boss')])).toThrow('boss')
  })
})

/**
 * 「两份扫描」的一致性。
 *
 * 站点清单在两处被扫出来：运行时/测试用 Vite 的 `import.meta.glob`，
 * manifest 生成器（Node，没有 glob）用 `scripts/site-descriptors.ts` 自己扫目录。
 * 两份实现分叉的症状是「终端里生成的 manifest 与扩展实际认的站点不一致」——
 * 例如新增站点后 manifest 没给它主机权限，表现得像扩展坏了。
 *
 * 因此这里把两边**扫出来的站点（路径 + id）**钉在一起：任何一边漏掉或多出一个就红。
 */
describe('node 侧扫描与 Vite glob 一致', () => {
  it('两处扫出的站点路径与 id 完全相同', async () => {
    const { scanSiteDescriptors } = await import('../../../../scripts/site-descriptors')
    const fromNode = (await scanSiteDescriptors()).map(site => site.id).sort()

    /*
     * Vite 侧的 glob 与 routing.ts 用的是同一个（`sites/**\/meta.ts`）。
     * ⚠ 不能直接用 glob 键当 id：平台目录本身（`feishu/meta.ts`）也存在，
     *   站点是它的**子目录**。所以取叶子目录名当 id，用 `siteIdFromPath` 同一套规则。
     */
    const fromVite = Object.keys(import.meta.glob('../**/meta.ts'))
      .map(siteIdFromPath)
      .sort()

    expect(fromNode).toEqual(fromVite)
  })

  it('平台目录本身不算站点，它下面的租户才算', async () => {
    const { scanSiteDescriptors } = await import('../../../../scripts/site-descriptors')
    const ids = (await scanSiteDescriptors()).map(site => site.id)

    // `feishu/` 是平台层（没有 meta.ts），`feishu/mediastorm/` 才是站点
    expect(ids).not.toContain('feishu')
    expect(ids).toContain('mediastorm')
  })
})
