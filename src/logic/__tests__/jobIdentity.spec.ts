import type { JobView } from '../types'
import { describe, expect, it } from 'vitest'
import { createEmptyJobView, jobIdentity, recordKey } from '../types'

/**
 * 岗位身份（账本键的来源）的测试。
 *
 * 这一支钉住的是一次真机故障：BOSS 新版职位页的地址里没有 securityId，而详情
 * 可能整块由服务端渲染（页面上没有可捕获的接口响应），于是 DOM 兜底路径拿不到
 * 任何站点标识 —— 那时若放弃记账，用户点「匹配度分析」后结果**只出现在提示条里**，
 * 面板永远看不到分数。因此「站点给不出标识也要有一个稳定身份」是硬要求。
 */

function view(patch: Partial<JobView>): JobView {
  return createEmptyJobView({ job: { title: '后端工程师' }, jdText: '岗位职责：写代码', ...patch })
}

describe('jobIdentity', () => {
  it('有站点标识时原样用它（不改写站点给的东西）', () => {
    const job = view({ site: { siteId: 'boss', naturalKey: 'abc123' } })

    expect(jobIdentity(job)).toBe(job.site)
    expect(jobIdentity(job).naturalKey).toBe('abc123')
  })

  it('没有站点标识时退回内容摘要，且带 `~` 前缀以示区别', () => {
    const identity = jobIdentity(view({ site: { siteId: 'boss', naturalKey: '' } }))

    // 64 位十六进制：单个 32 位在千条账本规模下已有约万分之一的撞车概率
    expect(identity.naturalKey).toMatch(/^~[0-9a-f]{16}$/)
    // 站点身份本身不能被丢掉（账本键的命名空间来自它）
    expect(identity.siteId).toBe('boss')
  })

  it('同一份内容每次算出的身份相同（否则每次打开面板都查不到上次的结果）', () => {
    const a = jobIdentity(view({ site: { siteId: 'boss', naturalKey: '' } }))
    const b = jobIdentity(view({ site: { siteId: 'boss', naturalKey: '' } }))

    expect(a.naturalKey).toBe(b.naturalKey)
  })

  it('内容不同则身份不同', () => {
    const a = jobIdentity(view({ site: { siteId: 'boss', naturalKey: '' }, jdText: '岗位职责：写代码' }))
    const b = jobIdentity(view({ site: { siteId: 'boss', naturalKey: '' }, jdText: '岗位职责：做设计' }))

    expect(a.naturalKey).not.toBe(b.naturalKey)
  })

  it('正文在末尾继续追加时身份不变（摘要只看到开头一段）', () => {
    // 两份都超过取样长度：页面上「先出摘要、展开后出全文」就是这种关系
    const head = '岗位职责：负责服务端架构设计与性能优化，'.repeat(12)
    const short = jobIdentity(view({ site: { siteId: 'boss', naturalKey: '' }, jdText: head }))
    const longer = jobIdentity(view({
      site: { siteId: 'boss', naturalKey: '' },
      jdText: `${head}任职要求：五年以上后端经验，熟悉分布式系统。`,
    }))

    expect(longer.naturalKey).toBe(short.naturalKey)
  })

  it('正文比取样长度还短时，追加内容会改变摘要 —— 真实路径靠内容脚本把身份钉住', () => {
    const short = jobIdentity(view({ site: { siteId: 'boss', naturalKey: '' }, jdText: '写代码' }))
    const longer = jobIdentity(view({ site: { siteId: 'boss', naturalKey: '' }, jdText: '写代码，还要写文档' }))

    // 这条不是在认可这个差异，而是把它记下来：sites/content-script.ts 会在第一次
    // 读到岗位时用 localJobKey 定下身份，之后只更新内容，所以不会走到这里
    expect(longer.naturalKey).not.toBe(short.naturalKey)
  })

  it('换行/空白差异不影响身份（接口文本与页面文本的排版常常不同）', () => {
    const api = jobIdentity(view({
      site: { siteId: 'boss', naturalKey: '' },
      jdText: '岗位职责：写代码\n\n任职要求：三年经验',
    }))
    const dom = jobIdentity(view({
      site: { siteId: 'boss', naturalKey: '' },
      jdText: '岗位职责：写代码  任职要求：三年经验',
    }))

    expect(dom.naturalKey).toBe(api.naturalKey)
  })

  it('标题不同则身份不同（同一份 JD 模板投到不同岗位时能分开）', () => {
    const a = jobIdentity(view({
      site: { siteId: 'boss', naturalKey: '' },
      job: { title: '后端工程师' },
    }))
    const b = jobIdentity(view({
      site: { siteId: 'boss', naturalKey: '' },
      job: { title: '前端工程师' },
    }))

    expect(a.naturalKey).not.toBe(b.naturalKey)
  })

  it('算出来的身份能直接当账本键用（两个站点各自的键不互相串）', () => {
    const boss = recordKey(jobIdentity(view({ site: { siteId: 'boss', naturalKey: '' } })))
    const eleduck = recordKey(jobIdentity(view({ site: { siteId: 'eleduck', naturalKey: '' } })))

    expect(boss.startsWith('boss:~')).toBe(true)
    expect(eleduck.startsWith('eleduck:~')).toBe(true)
    expect(boss).not.toBe(eleduck)
  })
})
