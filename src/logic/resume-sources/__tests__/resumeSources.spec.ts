import { describe, expect, it } from 'vitest'
import { gistSource } from '../gist'
import { pasteSource } from '../paste'
import { getResumeSource, normalizeResumeSource, RESUME_SOURCES, resumeSourceOptions } from '../registry'

/**
 * 简历来源注册表的测试。
 *
 * 这一支钉住的是本次重构真正要买的东西：**新增来源只加适配器 + 注册一行**。
 * 因此断言的重点不是某个来源的行为，而是注册表自身的不变量 ——
 * 下拉框选项、id 收敛、以及「每个来源都能造出完整配置」。
 */

describe('注册表的内容（RESUME_SOURCES）', () => {
  it('每个来源的 id 唯一（重复会让 getResumeSource 静默取到前一个）', () => {
    const ids = RESUME_SOURCES.map(source => source.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个来源都能造出完整配置、声明了 label 与 hint', () => {
    for (const source of RESUME_SOURCES) {
      expect(typeof source.label).toBe('string')
      expect(source.label.length).toBeGreaterThan(0)
      expect(typeof source.hint).toBe('string')
      expect(typeof source.createConfig()).toBe('object')
      expect(Array.isArray(source.configFields)).toBe(true)
      expect(typeof source.fetch).toBe('function')
      expect(typeof source.identify).toBe('function')
    }
  })

  it('identify 在空配置下返回空串（表示「还不同步」，而不是抛错）', () => {
    for (const source of RESUME_SOURCES) {
      expect(source.identify(source.createConfig())).toBe('')
    }
  })
})

describe('getResumeSource / normalizeResumeSource', () => {
  it('按 id 取到对应适配器', () => {
    expect(getResumeSource('gist')).toBe(gistSource)
    expect(getResumeSource('paste')).toBe(pasteSource)
  })

  it('未知 id 返回 undefined（存储里可能残留已废弃的来源）', () => {
    expect(getResumeSource('pdf')).toBeUndefined()
    expect(getResumeSource('')).toBeUndefined()
  })

  it('未知值一律收敛成「手动输入」', () => {
    expect(normalizeResumeSource('gist')).toBe('gist')
    expect(normalizeResumeSource('pdf')).toBe('paste')
    expect(normalizeResumeSource(null)).toBe('paste')
    expect(normalizeResumeSource(123)).toBe('paste')
  })
})

describe('resumeSourceOptions', () => {
  it('选项与注册表一一对应（下拉框由注册表驱动，不再写死）', () => {
    const options = resumeSourceOptions()

    expect(options.map(option => option.value)).toEqual(RESUME_SOURCES.map(source => source.id))
    expect(options[0]).toEqual({
      value: 'paste',
      label: pasteSource.label,
      hint: pasteSource.hint,
    })
  })
})

/**
 * 手动输入也要能塞进同一套接口。
 *
 * 它是「这套抽象不是照着 Gist 剪裁的」的证据：没有配置、不发请求、内容就在眼前，
 * 却依然满足同一个契约。
 */
describe('pasteSource', () => {
  it('没有配置项，也不发请求', async () => {
    expect(pasteSource.configFields).toEqual([])
    expect(pasteSource.createConfig()).toEqual({})

    const content = await pasteSource.fetch({})
    // 空 contentKey 是约定的信号：没有远端内容可取，界面据此不写回简历
    expect(content.contentKey).toBe('')
    expect(content.markdown).toBe('')
  })
})

/**
 * Gist 适配器的契约细节 —— 尤其是 identify 与 fetch 的 key 必须同源：
 * 两者拼法一旦不一致，防回环就失效，会白发一次请求。
 */
describe('gistSource', () => {
  it('identify 未填地址时为空，填了就带上文件名', () => {
    expect(gistSource.identify({ gistId: '' })).toBe('')
    expect(gistSource.identify({ gistId: 'abc123' })).toBe('abc123|')
    expect(gistSource.identify({ gistId: 'abc123', fileName: 'resume.md' })).toBe('abc123|resume.md')
  })

  it('identify 认链接（粘地址栏也能算出一致的 key）', () => {
    expect(gistSource.identify({ gistId: 'https://gist.github.com/octocat/abc123' })).toBe('abc123|')
  })

  it('非字符串的配置值不炸（存储里可能有脏数据）', () => {
    expect(gistSource.identify({ gistId: 42 })).toBe('')
    expect(gistSource.identify({ gistId: 'abc123', fileName: null })).toBe('abc123|')
  })

  it('地址认不出来时明确报错，而不是发一个空请求', async () => {
    await expect(gistSource.fetch({ gistId: '我的简历' })).rejects.toThrow('Gist 地址无法识别')
  })
})
