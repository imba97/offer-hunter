import { describe, expect, it } from 'vitest'
import {
  buildGreetingSystem,
  buildMatchSystem,
  buildPromptJobText,
  fitInputs,
  normalizeGreeting,
  normalizeMatchResult,
  normalizeScore,
} from '../matching'
import { createAiProvider } from '../platforms'
import { buildJsonSystem, jsonRequestOverhead, parseJsonLoose } from '../structured'

/**
 * AI 层单测：容错解析 + 模型返回值的归一化 + 输入裁剪。
 *
 * 这三处的共同点是「模型不按格式回」时的表现：以前是直接把 JSON 断言成
 * MatchResult，漏字段就会在上层抛出 TypeError。归一化的目的就是让坏响应
 * 要么被修好，要么报一句人能看懂的话。
 */

describe('parseJsonLoose', () => {
  it('直接解析纯 JSON', () => {
    expect(parseJsonLoose<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  it('剥离 ```json 代码块', () => {
    expect(parseJsonLoose<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('剥离代码块外的前后解释文字', () => {
    expect(parseJsonLoose<{ a: number }>('好的，结果如下：\n{"a":1}\n希望有帮助')).toEqual({ a: 1 })
  })

  it('空内容报明确错误', () => {
    expect(() => parseJsonLoose('   ')).toThrow('模型返回了空内容')
  })

  it('完全解析不了时报错并带上原文片段', () => {
    expect(() => parseJsonLoose('完全不是 JSON')).toThrow('无法从模型返回中解析出 JSON')
  })
})

describe('normalizeScore', () => {
  it('取整并限制在 0-100', () => {
    expect(normalizeScore(85.4)).toBe(85)
    expect(normalizeScore(-10)).toBe(0)
    expect(normalizeScore(120)).toBe(100)
  })

  it('兼容字符串数字', () => {
    expect(normalizeScore('72')).toBe(72)
  })

  it('兼容 0-1 的比例写法，但不把 1 分当成 100', () => {
    expect(normalizeScore(0.85)).toBe(85)
    expect(normalizeScore(1)).toBe(1)
    expect(normalizeScore(0)).toBe(0)
  })

  it('不是数字时返回 null（交给上层报错）', () => {
    expect(normalizeScore(undefined)).toBeNull()
    expect(normalizeScore('高')).toBeNull()
  })
})

describe('normalizeMatchResult', () => {
  it('正常返回原样保留', () => {
    const result = normalizeMatchResult({
      score: 88,
      summary: '很匹配',
      reasons: ['技术栈吻合', '  '],
      missingSkills: ['Kubernetes'],
    })

    expect(result.score).toBe(88)
    expect(result.reasons).toEqual(['技术栈吻合'])
    expect(result.missingSkills).toEqual(['Kubernetes'])
  })

  it('数组字段缺失时退化为空数组（不再抛 TypeError）', () => {
    const result = normalizeMatchResult({ score: 55 })

    expect(result.reasons).toEqual([])
    expect(result.missingSkills).toEqual([])
    expect(result.summary).toBe('')
  })

  it('分数缺失时明确报错，而不是静默算 0 分', () => {
    expect(() => normalizeMatchResult({ summary: '还行' })).toThrow('没有可用的匹配度分数')
  })

  it('数组过长时截断，避免面板被刷屏', () => {
    const result = normalizeMatchResult({
      score: 70,
      reasons: Array.from({ length: 20 }, (_, i) => `理由 ${i}`),
      missingSkills: Array.from({ length: 20 }, (_, i) => `技能 ${i}`),
    })

    expect(result.reasons).toHaveLength(8)
    expect(result.missingSkills).toHaveLength(8)
  })
})

describe('normalizeGreeting', () => {
  it('去掉首尾空白', () => {
    expect(normalizeGreeting({ greeting: '  您好，我在 XX 做过 5 年后端。  ', rationale: '贴合' }))
      .toEqual({ greeting: '您好，我在 XX 做过 5 年后端。', rationale: '贴合' })
  })

  it('超长时硬截断（BOSS 输入框不友好）', () => {
    const long = '啊'.repeat(500)
    const result = normalizeGreeting({ greeting: long })

    expect(result.greeting.length).toBeLessThanOrEqual(200)
    expect(result.greeting.endsWith('...')).toBe(true)
  })

  it('没有正文时明确报错', () => {
    expect(() => normalizeGreeting({ rationale: '只有理由' })).toThrow('没有返回招呼语内容')
  })
})

/**
 * 自定义提示词的拼装。
 *
 * 用户写的东西必须真的进到那一轮的 prompt 里，而且不能被当成「仅供参考」——
 * 判据是它单独成段并声明了优先级。两段提示词走同一条路径，所以这里对
 * buildMatchSystem / buildGreetingSystem 各断言一遍。
 */
describe('自定义提示词的拼装', () => {
  it('没有自定义提示词时就是内置提示词', () => {
    expect(buildMatchSystem('')).toBe(buildMatchSystem('  \n '))
    expect(buildGreetingSystem('')).toBe(buildGreetingSystem('  \n '))
    expect(buildMatchSystem('')).not.toContain('用户的额外要求')
  })

  it('拼接时保留内置要求，并把用户那段标成优先级最高', () => {
    const base = buildMatchSystem('')
    const custom = buildMatchSystem('更看重高并发经验')

    expect(custom.startsWith(base)).toBe(true)
    expect(custom).toContain('优先级最高')
    expect(custom).toContain('更看重高并发经验')
  })

  it('招呼语与匹配度分析各走各的提示词，互不串味', () => {
    const greeting = buildGreetingSystem('开头用您好')

    expect(greeting).toContain('开头用您好')
    expect(greeting).not.toContain('技术招聘顾问')
  })
})

describe('fitInputs', () => {
  it('不超限时原样返回', () => {
    const provider = createAiProvider('deepseek', { apiKey: 'sk-1' })
    const out = fitInputs(provider, '简历', 'JD', 0)

    expect(out).toEqual({ resume: '简历', jd: 'JD', truncated: false })
  })

  it('超限时截断并标记 truncated', () => {
    const provider = createAiProvider('custom', { apiKey: 'sk-1', baseUrl: 'http://x/v1', model: 'm' })
    const resume = '简'.repeat(40_000)

    const out = fitInputs(provider, resume, 'JD', 0)

    expect(out.truncated).toBe(true)
    expect(out.resume.length).toBeLessThan(resume.length)
    expect(out.resume).toContain('简历过长')
    // JD 预算独立计算，不该因为简历超长就被吃掉
    expect(out.jd).toBe('JD')
  })

  /**
   * 固定开销（system + 用户自定义提示词 + 消息包装）必须真的从预算里扣掉。
   *
   * 这条替代了此前那个 `PROMPT_RESERVE = 2000` 的常量估算：估出来的值不会随
   * 用户提示词变长而变，于是「提示词写得很长」完全不进预算，裁剪后照样超限。
   */
  it('固定开销从预算里扣掉，且不会把小额度反向抬高', () => {
    const provider = createAiProvider('custom', { apiKey: 'sk-1', baseUrl: 'http://x/v1', model: 'm' })
    const big = '字'.repeat(100_000)

    // 开销更大 → 放行内容更少
    const small = fitInputs(provider, big, big, 1_000)
    const large = fitInputs(provider, big, big, 20_000)
    expect(large.resume.length + large.jd.length)
      .toBeLessThan(small.resume.length + small.jd.length)

    // 开销已经吃掉整个额度时，一块内容都不该放行（旧实现会硬放 4000 字符）
    const over = fitInputs(provider, big, big, provider.capabilities.maxInputChars + 1)
    expect(over.resume).toBe('')
    expect(over.jd).toBe('')
    expect(over.truncated).toBe(true)
  })
})

describe('jsonRequestOverhead', () => {
  it('等于最终 system 实长加上消息里的固定字符（不含载荷）', () => {
    const system = buildGreetingSystem('')
    const emptyUser = '## 我的简历\n\n\n## 目标岗位\n某岗位\n\n## 岗位描述（JD）\n'
    /*
     * 注意量的是 `buildJsonSystem(system)`：requestJson 还会追加那段「输出要求」，
     * 那部分同样是固定开销，必须在预算里扣掉。
     */
    expect(jsonRequestOverhead({ system, schemaHint: 'schema' }, emptyUser.length, 0))
      .toBe(buildJsonSystem({ system, schemaHint: 'schema' }).length + emptyUser.length)
  })

  it('用户提示词变长时开销同步变大（这正是旧常量估算漏掉的部分）', () => {
    const short = jsonRequestOverhead({ system: buildMatchSystem(''), schemaHint: 's' }, 10)
    const long = jsonRequestOverhead({ system: buildMatchSystem('多'.repeat(500)), schemaHint: 's' }, 10)

    /*
     * 增量 ≥ 提示词本身：`withUserPrompt` 除了原文还会加一段固定说明（优先级声明），
     * 所以差额比 500 略大。这里只钉「确实进了预算」，不钉那段文案的字数。
     */
    expect(long - short).toBeGreaterThanOrEqual(500)
  })
})

/**
 * 通用岗位模型 → 提示词文本。
 *
 * 这一层是「加第二个招聘网站时 AI 侧不用改」的保证：输入只有 JobCore，
 * 站点私有字段一律不出现。缺字段必须退化成空串而不是 undefined。
 */
describe('buildPromptJobText', () => {
  const fullJob = {
    title: '高级后端工程师',
    company: '某某科技',
    salary: '25-40K',
    experience: '3-5 年',
    degree: '本科',
    location: { city: '上海', district: '浦东新区', businessDistrict: '张江' },
    skills: ['Go', 'Kubernetes'],
    companyIndustry: '互联网',
    companyScale: '500-999 人',
    recruiter: { name: '张女士', title: '招聘主管' },
  }

  it('站点无关字段逐项拼进文本', () => {
    const text = buildPromptJobText(fullJob)

    expect(text).toContain('职位：高级后端工程师')
    expect(text).toContain('公司：某某科技（互联网 / 500-999 人）')
    expect(text).toContain('薪资：25-40K')
    expect(text).toContain('经验要求：3-5 年')
    expect(text).toContain('学历要求：本科')
    expect(text).toContain('地点：上海浦东新区 · 张江')
    expect(text).toContain('技能标签：Go、Kubernetes')
  })

  it('招聘者默认不出现，只有招呼语那一轮要', () => {
    expect(buildPromptJobText(fullJob)).not.toContain('招聘者')
    expect(buildPromptJobText(fullJob, { withRecruiter: true })).toContain('招聘者：张女士（招聘主管）')
  })

  it('字段缺失时退化成空串，不出现 undefined', () => {
    const text = buildPromptJobText({ title: '前端工程师' })

    expect(text).toContain('职位：前端工程师')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('招聘者')
  })
})
