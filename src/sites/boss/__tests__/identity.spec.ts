import { describe, expect, it } from 'vitest'
import { jobIdentity, recordKey } from '~/logic/types'
import { toJobView } from '../api'

/**
 * 岗位身份：**同内容必须得到同一个账本键，哪怕 token 变了**。
 *
 * 真机症状（这条测试就是为了不再复发）：BOSS 的 securityId 每次访问都新签一个，
 * 曾经拿它当身份，于是同一个岗位每刷新一次就变成另一个 `boss:<一长串>` ——
 * 刚存进账本的分析结果再也查不到，用户看到的是「一刷新信息就没了」。
 *
 * 因此身份由内容摘要承担（标题 + JD 开头），token 只作为取数凭据留在 `ids` 里。
 */

/** BOSS 详情接口响应的最小形状（toJobView 直接吃 zpData） */
function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    jobInfo: {
      jobName: '全栈工程师',
      postDescription: '岗位职责：负责跨境电商系统的前后端开发与维护。',
      salaryDesc: '25-40K',
      ...overrides,
    },
    bossInfo: { name: '李女士', title: 'HR' },
    brandComInfo: { brandName: '商云科汇' },
  }
}

const TOKEN_A = 'IA87KztPW7zOB-X1-xUtUenZHeLUG2lD3SYNgRgXfSAqxAmFck5OaaFftNV58V5Bj~'
const TOKEN_B = 'ILsuWHYYtShwG-x1vQzyW0W96kv0Ayno2NX1GjFz_nfptDCuuadl3qzEybvPnqwTVLIchy6~'

describe('boss 岗位身份', () => {
  it('token 不同但内容相同 → 账本键相同（刷新不会再丢结果）', () => {
    const first = toJobView(payload(), TOKEN_A)!
    const second = toJobView(payload(), TOKEN_B)!

    expect(first).not.toBeNull()
    expect(recordKey(jobIdentity(first))).toBe(recordKey(jobIdentity(second)))
    // 摘要形态：前缀 `~`，不是那一长串 token
    expect(jobIdentity(first).naturalKey.startsWith('~')).toBe(true)
  })

  it('token 仍然留着 —— 重新取数与深链要用它', () => {
    const view = toJobView(payload(), TOKEN_A)!

    expect(view.site.naturalKey).toBe('') // 身份不占用它
    expect(view.site.ids?.securityId).toBe(TOKEN_A)
  })

  it('内容不同 → 账本键不同（不同岗位不能撞在一起）', () => {
    const a = toJobView(payload(), TOKEN_A)!
    const b = toJobView(payload({ jobName: '后端工程师' }), TOKEN_A)!

    expect(recordKey(jobIdentity(a))).not.toBe(recordKey(jobIdentity(b)))
  })

  it('jD 第 200 字之后的内容变化不影响身份（增量渲染不该换身份）', () => {
    /*
     * 摘要只取**规范化后前 200 个字符**（`IDENTITY_SAMPLE_CHARS`）。这是刻意的：
     * BOSS 的 JD 常常是增量渲染的（先出摘要、展开后补全文），用全文算身份的话
     * 内容一变长就变成另一个岗位，等于每次都要重新分析（types.ts 里有这段理由）。
     *
     * ⚠ 反过来也成立：**前 200 字内**的任何改动都会换身份 —— 这是该设计的已知代价。
     */
    const long = '岗位职责：负责跨境电商系统的前后端开发与维护，并参与架构评审。'.repeat(12)
    expect(long.length).toBeGreaterThan(200)

    const before = toJobView(payload({ postDescription: long }), TOKEN_A)!
    const after = toJobView(payload({ postDescription: `${long}\n\n任职要求：五年以上经验。` }), TOKEN_A)!

    expect(recordKey(jobIdentity(before))).toBe(recordKey(jobIdentity(after)))
  })
})
