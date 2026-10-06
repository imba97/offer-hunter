import type { ResumeSourceAdapter } from '~/adapters/resume-sources/types'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import gistSource from '~/adapters/resume-sources/gist'
import { callBackground } from '~/logic/messaging'
import ResumeSourcePanel from '../ResumeSourcePanel.vue'

/**
 * 简历来源通用面板的行为测试（以 Gist 适配器驱动）。
 *
 * 组件很小，但要紧的是那串「配置变化 → 自动同步」的编排：
 *  - 只填 ID、没有任何凭据也要能同步
 *  - 自动同步必须防抖（输入框是敲出来的，不该每敲一个字符发一次请求）
 *  - 回写文件名不能把自己再点着（否则同步 → 写回 → 同步 会成回环）
 *  - 输入框既能填裸 ID，也能粘链接；认不出来时不要改坏配置
 *  - **回写配置不能冲掉用户正在编辑的输入框**（dirty 标记）
 *
 * 编排本身（防抖 / 节流 / 状态机 / 经后台取数）在 useResumeSourceSync，
 * 所以本文件同时也是那个 composable 的集成测试 —— 只有把组件和它放在一起
 * 才能观察到这些行为。
 *
 * 界面完全由 configFields 驱动，因此这里也是在验证「加一个普通来源不用写组件」。
 */

vi.mock('~/logic/messaging', () => ({ callBackground: vi.fn() }))

const GIST_ID = 'aa5a315d61ae9438b18d'

/** 自动同步的防抖窗口 + 一点余量 */
const DEBOUNCE_MS = 400

/** 一份内容的标识：由适配器给出，与它内部的 buildGistContentKey 一致 */
function sourceKey(gistId: string, fileName = ''): string {
  return `${gistId}|${fileName}`
}

function mountPanel(
  config: Partial<{ token: string, gistId: string, fileName: string }> = {},
  synced: { syncedAt?: string | null, syncedKey?: string | null } = {},
  adapter: ResumeSourceAdapter = gistSource,
) {
  const wrapper = mount(ResumeSourcePanel, {
    props: {
      adapter,
      config: { token: '', gistId: '', fileName: '', ...config },
      syncedAt: synced.syncedAt ?? null,
      syncedKey: synced.syncedKey ?? null,
    },
  })

  // Gist 有两个字段（配置里声明了几个就有几个 input），都走 SecretInput
  const [input, tokenInput] = wrapper.findAll('input')

  return { wrapper, input, tokenInput }
}

function lastUpdate(wrapper: ReturnType<typeof mountPanel>['wrapper']) {
  const emitted = wrapper.emitted('update:config')
  return emitted ? emitted[emitted.length - 1][0] : null
}

/** 一次成功的同步响应：后台把适配器的结果包在 content 里 */
function okFetch(markdown = '# 我', fileName = 'resume.md', items = ['resume.md', 'notes.md']) {
  return {
    ok: true,
    content: {
      markdown,
      contentKey: sourceKey(GIST_ID, fileName),
      label: fileName,
      // 回写进配置的是 item（能与 items 对上的键），不是展示用的 label
      item: fileName,
      items,
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(callBackground).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('表单由 configFields 驱动', () => {
  it('每个声明过的字段渲染一个输入框，占位符与「可选」徽标都来自声明', () => {
    const { wrapper, input, tokenInput } = mountPanel({ gistId: GIST_ID })

    expect(wrapper.findAll('input')).toHaveLength(2)
    expect(input.attributes('placeholder')).toContain('gist.github.com')
    expect(tokenInput.attributes('placeholder')).toBe('ghp_… / github_pat_…')
    // token 声明了 optional: true，因此有「可选」徽标；gistId 没有
    expect(wrapper.text()).toContain('可选')
    expect(wrapper.text()).toContain('明文存在本机')
  })

  it('secret 字段一律遮住内容（链接本身就是读简历的凭据）', () => {
    const { wrapper, input, tokenInput } = mountPanel({ gistId: GIST_ID })

    expect(input.attributes('type')).toBe('password')
    expect(tokenInput.attributes('type')).toBe('password')
    expect(wrapper.findAll('button.oh-secret-eye')).toHaveLength(2)
  })

  it('没有配置项的来源不渲染任何输入框，但仍然能手动同步', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper } = mountPanel({}, {}, {
      ...gistSource,
      id: 'paste',
      configFields: [],
      createConfig: () => ({}),
      normalize: undefined,
    })

    expect(wrapper.findAll('input')).toHaveLength(0)
    await wrapper.get('button.oh-btn-primary').trigger('click')
    expect(callBackground).toHaveBeenCalledTimes(1)
  })
})

describe('自动同步', () => {
  it('没填 Gist 时不发请求', async () => {
    mountPanel()

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).not.toHaveBeenCalled()
  })

  it('只有 ID、没有 token 也照样同步', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper } = mountPanel({ gistId: GIST_ID })

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(callBackground).toHaveBeenCalledWith('resume-source:fetch', {
      sourceId: 'gist',
      config: { token: '', gistId: GIST_ID, fileName: '' },
    })
    expect(wrapper.emitted('synced')?.[0]).toEqual([
      { markdown: '# 我', contentKey: sourceKey(GIST_ID, 'resume.md'), label: 'resume.md' },
    ])
    expect(wrapper.text()).toContain('已同步 3 字 · resume.md')
  })

  it('填了 token 就随请求带上（只为提额度）', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    mountPanel({ gistId: GIST_ID, token: ' ghp_x ' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(callBackground).toHaveBeenCalledWith('resume-source:fetch', {
      sourceId: 'gist',
      config: { token: ' ghp_x ', gistId: GIST_ID, fileName: '' },
    })
  })

  it('10 分钟内已经同步过同一份内容时，不再自动重复取', async () => {
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'))
    const { wrapper } = mountPanel(
      { gistId: GIST_ID },
      {
        syncedAt: new Date('2026-03-01T11:55:00Z').toISOString(), // 5 分钟前
        syncedKey: sourceKey(GIST_ID),
      },
    )

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('10 分钟内已同步过')
  })

  it('超过 10 分钟后照常自动同步', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'))

    mountPanel(
      { gistId: GIST_ID },
      {
        syncedAt: new Date('2026-03-01T11:49:00Z').toISOString(),
        syncedKey: sourceKey(GIST_ID),
      },
    )

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).toHaveBeenCalledTimes(1)
  })

  /**
   * 配置里没有文件名（还等着自动挑）时，存的 key 与 `identify()` 算出来的**不会完全相等**。
   *
   * 这是防回环与节流最容易同时失效的情形：要求两者相等的话，这条节流永远不生效，
   * 于是每开一次设置页都白发一次请求（GitHub 匿名额度只有 60 次/小时）。
   */
  it('配置里还没回写文件名时，也能认出「就是刚取过的那一份」', async () => {
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'))
    const { wrapper } = mountPanel(
      { gistId: GIST_ID }, // fileName 留空：identify 给 `<id>|`，而存的是 `<id>|resume.md`
      {
        syncedAt: new Date('2026-03-01T11:55:00Z').toISOString(),
        syncedKey: sourceKey(GIST_ID, 'resume.md'),
      },
    )

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('10 分钟内已同步过')
  })

  it('换了 Gist 就不受间隔限制（旧时间不属于新内容）', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'))

    mountPanel(
      { gistId: 'bb5a315d61ae9438b18d' },
      {
        syncedAt: new Date('2026-03-01T11:59:00Z').toISOString(), // 1 分钟前，但属于另一个 Gist
        syncedKey: sourceKey(GIST_ID),
      },
    )

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).toHaveBeenCalledTimes(1)
  })

  it('没有来源记录时（旧数据）不拿旧时间去挡', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'))

    mountPanel(
      { gistId: GIST_ID },
      { syncedAt: new Date('2026-03-01T11:59:00Z').toISOString() },
    )

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).toHaveBeenCalledTimes(1)
  })

  it('手动点「同步简历」不受 10 分钟限制', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'))

    const { wrapper } = mountPanel(
      { gistId: GIST_ID },
      {
        syncedAt: new Date('2026-03-01T11:59:00Z').toISOString(),
        syncedKey: sourceKey(GIST_ID),
      },
    )
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)
    expect(callBackground).not.toHaveBeenCalled()

    // 两个密码框（Gist 链接/ID、可选 token）都是 SecretInput，里面各有一个小眼睛按钮，
    // 所以这里按类名挑「同步简历」那个按钮，不能用 `get('button')`
    await wrapper.get('button.oh-btn-primary').trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    expect(callBackground).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('已同步 3 字')
  })

  it('同步失败时把后台的理由显示出来', async () => {
    vi.mocked(callBackground).mockResolvedValue({
      ok: false,
      error: '取不到这个 Gist（404）：ID 写错了，或者它已经被删除',
    })

    const { wrapper } = mountPanel({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(wrapper.text()).toContain('同步失败')
    expect(wrapper.text()).toContain('404')
    expect(wrapper.emitted('synced')).toBeUndefined()
  })

  /**
   * 并发同步：只有**最新**那一次的响应能改写状态。
   *
   * 真实的并发路径是「同步还在途时配置又变了」：同步按钮在 `syncing` 期间是 disabled
   * 的，所以点不出并发；而配置变化那条 watcher 不检查在途状态，会再发一次。
   * 旧响应后到时会覆盖新内容，并把 lastSyncKey 记成上一份 —— 于是下一次又变成
   * 「同一份内容再取一次」。
   */
  it('同步在途时配置又变了，旧响应不会覆盖新结果', async () => {
    const slow = okFetch('# 旧内容', 'old.md', ['old.md'])
    const fast = okFetch('# 新内容', 'new.md', ['new.md'])

    let resolveSlow: (v: unknown) => void = () => {}
    const slowPromise = new Promise((resolve) => {
      resolveSlow = resolve
    })

    vi.mocked(callBackground)
      .mockReturnValueOnce(slowPromise as never) // 第一次：挂着不回
      .mockResolvedValueOnce(fast as never) // 第二次：立刻回

    const { wrapper } = mountPanel({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(callBackground).toHaveBeenCalledTimes(1)

    // 在途时用户又改了配置 → 去抖后发起第二次同步
    await wrapper.setProps({ config: { gistId: GIST_ID, token: '', fileName: '', ...{} } as never })
    await wrapper.setProps({ config: { gistId: 'cc5a315d61ae9438b18d', token: '', fileName: '' } as never })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(callBackground).toHaveBeenCalledTimes(2)

    const emitted = wrapper.emitted('synced') as any[]
    expect(emitted, '第二次同步应当已经带回内容').toBeTruthy()
    expect(emitted.at(-1)[0]).toMatchObject({ markdown: '# 新内容' })

    // 现在让那个慢的旧请求回来：它不该再改任何状态
    resolveSlow(slow)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect((wrapper.emitted('synced') as any[]).at(-1)[0]).toMatchObject({ markdown: '# 新内容' })
    expect(wrapper.text()).toContain('已同步 5 字 · new.md')
  })
})

describe('子项（换一份内容）', () => {
  it('同步成功后把实际用到的子项写回配置（itemField 声明写回哪个键）', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper } = mountPanel({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(lastUpdate(wrapper)).toMatchObject({ fileName: 'resume.md' })
  })

  it('回写子项不会触发第二轮同步（否则就是回环）', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper } = mountPanel({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(callBackground).toHaveBeenCalledTimes(1)

    // 真实父组件（v-model:config）会把 emit 出去的新配置灌回 props，这里重放这一步
    await wrapper.setProps({ config: lastUpdate(wrapper) as never })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).toHaveBeenCalledTimes(1)
  })

  /**
   * 回写只认 `item`，不认 `label`。
   *
   * 这条是这次契约修正的核心：`label` 是给人看的文案，来源可以把它写成
   * 「简历.md（已自动挑选）」这类带装饰的串；拿它回写配置会把一个不在 items 里的值
   * 写进去，下拉框于是选不中任何一项（且静默）。
   */
  it('label 只是展示文案，不会被回写进配置', async () => {
    vi.mocked(callBackground).mockResolvedValue({
      ok: true,
      content: {
        markdown: '# 我',
        contentKey: sourceKey(GIST_ID, 'resume.md'),
        label: '简历.md（已自动挑选）',
        item: 'resume.md',
        items: ['resume.md', 'notes.md'],
      },
    })

    const { wrapper } = mountPanel({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    // 回写的是 item（能与 items 对上的键），不是那句装饰文案
    expect(lastUpdate(wrapper)).toMatchObject({ fileName: 'resume.md' })
    expect(wrapper.text()).toContain('简历.md（已自动挑选）')
  })

  it('来源没给 item 时不回写配置（没有需要收敛的子项）', async () => {
    vi.mocked(callBackground).mockResolvedValue({
      ok: true,
      content: {
        markdown: '# 我',
        contentKey: sourceKey(GIST_ID, 'resume.md'),
        label: 'resume.md',
        items: ['resume.md'],
      },
    })

    const { wrapper } = mountPanel({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    // 没有 item 就没有配置可写：不该拿 label 顶替
    expect(wrapper.emitted('update:config')).toBeUndefined()
  })

  it('多个子项时出现下拉，换一项会带着新值重新同步', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper } = mountPanel({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    const select = wrapper.get('select')
    expect(select.findAll('option').map(option => option.text())).toEqual(['resume.md', 'notes.md'])
    // 下拉标题来自 itemLabel
    expect(wrapper.text()).toContain('同步哪个文件')

    vi.mocked(callBackground).mockClear()
    await select.setValue('notes.md')
    // 父组件把新配置灌回来，watch 应当带着新值再同步一次
    await wrapper.setProps({ config: lastUpdate(wrapper) as never })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(callBackground).toHaveBeenCalledWith('resume-source:fetch', {
      sourceId: 'gist',
      config: { token: '', gistId: GIST_ID, fileName: 'notes.md' },
    })
  })

  it('只有一个子项时不显示下拉', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch('# 我', 'resume.md', ['resume.md']))

    const { wrapper } = mountPanel({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(wrapper.find('select').exists()).toBe(false)
  })

  it('来源没声明 itemField 时不渲染下拉（没有子项概念）', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper } = mountPanel({ gistId: GIST_ID }, {}, {
      ...gistSource,
      itemField: undefined,
    })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(wrapper.find('select').exists()).toBe(false)
  })
})

describe('输入收敛（normalize）', () => {
  it('粘贴 gist 链接：失焦时收敛成 ID', async () => {
    const { wrapper, input } = mountPanel()

    await input.setValue(`https://gist.github.com/octocat/${GIST_ID}#file-resume-md`)
    await input.trigger('blur')

    expect(lastUpdate(wrapper)).toMatchObject({ gistId: GIST_ID, fileName: '' })
  })

  it('换了取数目标就清掉子项选择（上一份的子项不属于新目标）', async () => {
    const { wrapper, input } = mountPanel({ gistId: GIST_ID, fileName: 'resume.md' })

    await input.setValue('bb5a315d61ae9438b18d')
    await input.trigger('blur')

    expect(lastUpdate(wrapper)).toMatchObject({ gistId: 'bb5a315d61ae9438b18d', fileName: '' })
  })

  it('值没变时不发 update:config（避免无意义的配置写入与自动同步）', async () => {
    const { wrapper, input } = mountPanel({ gistId: GIST_ID })

    await input.setValue(GIST_ID)
    await input.trigger('blur')

    expect(wrapper.emitted('update:config')).toBeUndefined()
  })

  it('认不出来的输入被还原，不会把配置改坏', async () => {
    const { wrapper, input } = mountPanel({ gistId: GIST_ID })

    await input.setValue('随便打的字')
    await input.trigger('blur')

    expect(wrapper.emitted('update:config')).toBeUndefined()
    expect((input.element as HTMLInputElement).value).toBe(GIST_ID)
    expect(wrapper.text()).toContain('认不出这个输入')
  })

  it('回车提交与失焦等价', async () => {
    const { wrapper, input } = mountPanel()

    await input.setValue(`https://gist.github.com/octocat/${GIST_ID}`)
    await input.trigger('keydown', { key: 'Enter' })

    expect(lastUpdate(wrapper)).toMatchObject({ gistId: GIST_ID })
  })

  it('没有 normalize 的来源：输入原样存储', async () => {
    const { wrapper, input } = mountPanel({ gistId: '' }, {}, {
      ...gistSource,
      normalize: undefined,
    })

    await input.setValue('随便写点什么')
    await input.trigger('blur')

    expect(lastUpdate(wrapper)).toMatchObject({ gistId: '随便写点什么' })
  })
  it('输入框里的值以配置为准（用户粘链接后回写的是收敛值）', async () => {
    const { input } = mountPanel({ gistId: GIST_ID })

    expect((input.element as HTMLInputElement).value).toBe(GIST_ID)
  })
})

/**
 * 回写配置与「用户正在编辑」的冲突。
 *
 * 自动同步成功后会把实际取到的子项写回配置，那会触发一次 props 变化；
 * 若面板在这里整体用配置覆盖输入框，用户正在敲的内容就被抹掉了。
 */
describe('编辑中的输入框', () => {
  it('同步回写子项时不会冲掉正在编辑的字段', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper, tokenInput } = mountPanel({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    // 用户开始敲 token（还没失焦）
    await tokenInput.setValue('ghp_typing')
    // 父组件把回写后的配置灌回来（fileName 已变成实际取到的那个）
    await wrapper.setProps({ config: lastUpdate(wrapper) as never })

    expect((tokenInput.element as HTMLInputElement).value).toBe('ghp_typing')
  })

  it('失焦后才把编辑的字段提交进配置', async () => {
    const { wrapper, tokenInput } = mountPanel({ gistId: GIST_ID })

    await tokenInput.setValue('ghp_pasted')
    // 还没失焦：配置不该动（否则每敲一个字符都可能触发一次同步）
    expect(wrapper.emitted('update:config')).toBeUndefined()

    await tokenInput.trigger('blur')
    expect(lastUpdate(wrapper)).toMatchObject({ token: 'ghp_pasted' })
  })
})
