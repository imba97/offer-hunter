import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callBackground } from '~/logic/messaging'
import GistPicker from '../GistPicker.vue'

/**
 * Gist 面板的行为测试。
 *
 * 组件很小，但要紧的是那串「配置变化 → 自动同步」的编排：
 *  - 只填 ID、没有任何凭据也要能同步
 *  - 自动同步必须防抖（输入框是敲出来的，不该每敲一个字符发一次请求）
 *  - 回写文件名不能把自己再点着（否则同步 → 写回 → 同步 会成回环）
 *  - 输入框既能填裸 ID，也能粘链接；认不出来时不要改坏配置
 */

vi.mock('~/logic/messaging', () => ({ callBackground: vi.fn() }))

const GIST_ID = 'aa5a315d61ae9438b18d'

/** 自动同步的防抖窗口（组件里的 AUTO_SYNC_DEBOUNCE_MS）+ 一点余量 */
const DEBOUNCE_MS = 400

/** 一份内容的标识，与组件里 sourceKey 的约定一致 */
function sourceKey(gistId: string, fileName = ''): string {
  return `${gistId}|${fileName}`
}

function mountPicker(
  config: Partial<{ token: string, gistId: string, fileName: string }> = {},
  synced: { syncedAt?: string | null, syncedFrom?: string | null } = {},
) {
  const wrapper = mount(GistPicker, {
    props: {
      config: { token: '', gistId: '', fileName: '', ...config },
      syncedAt: synced.syncedAt ?? null,
      syncedFrom: synced.syncedFrom ?? null,
    },
  })

  // 模板里有两个 input：Gist 链接/ID、以及可选的 token
  const [input, tokenInput] = wrapper.findAll('input')

  return { wrapper, input, tokenInput }
}

function lastUpdate(wrapper: ReturnType<typeof mountPicker>['wrapper']) {
  const emitted = wrapper.emitted('update:config')
  return emitted ? emitted[emitted.length - 1][0] : null
}

/** 一次成功的同步响应 */
function okFetch(markdown = '# 我', fileName = 'resume.md', files = ['resume.md', 'notes.md']) {
  return { ok: true, gistId: GIST_ID, fileName, markdown, files }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(callBackground).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('gistPicker', () => {
  it('没填 Gist 时不发请求', async () => {
    mountPicker()

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).not.toHaveBeenCalled()
  })

  it('只有 ID、没有 token 也照样同步', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper } = mountPicker({ gistId: GIST_ID })

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(callBackground).toHaveBeenCalledWith('gist-fetch', {
      gistId: GIST_ID,
      fileName: '',
      token: '',
    })
    expect(wrapper.emitted('synced')?.[0]).toEqual([
      { markdown: '# 我', gistId: GIST_ID, fileName: 'resume.md' },
    ])
    expect(wrapper.text()).toContain('已同步 3 字 · 文件 resume.md')
  })

  it('填了 token 就随请求带上（只为提额度）', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper } = mountPicker({ gistId: GIST_ID, token: ' ghp_x ' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(callBackground).toHaveBeenCalledWith('gist-fetch', {
      gistId: GIST_ID,
      fileName: '',
      token: 'ghp_x',
    })
    expect(wrapper.text()).toContain('可选')
  })

  it('同步成功后把实际用到的文件名写回配置', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper } = mountPicker({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(lastUpdate(wrapper)).toMatchObject({ fileName: 'resume.md' })
  })

  it('回写文件名不会触发第二轮同步（否则就是回环）', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper } = mountPicker({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(callBackground).toHaveBeenCalledTimes(1)

    // 真实父组件（v-model:config）会把 emit 出去的新配置灌回 props，这里重放这一步
    await wrapper.setProps({ config: lastUpdate(wrapper) as never })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).toHaveBeenCalledTimes(1)
  })

  it('多个文件时出现文件下拉，换文件会带着新文件名重新同步', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper } = mountPicker({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    const select = wrapper.get('select')
    expect(select.findAll('option').map(option => option.text())).toEqual(['resume.md', 'notes.md'])

    vi.mocked(callBackground).mockClear()
    await select.setValue('notes.md')
    // 父组件把新配置灌回来，watch 应当带着新文件名再同步一次
    await wrapper.setProps({ config: lastUpdate(wrapper) as never })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(callBackground).toHaveBeenCalledWith('gist-fetch', {
      gistId: GIST_ID,
      fileName: 'notes.md',
      token: '',
    })
  })

  it('只有一个文件时不显示文件下拉', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch('# 我', 'resume.md', ['resume.md']))

    const { wrapper } = mountPicker({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(wrapper.find('select').exists()).toBe(false)
  })

  it('粘贴 gist 链接：失焦时收敛成 ID', async () => {
    const { wrapper, input } = mountPicker()

    await input.setValue(`https://gist.github.com/octocat/${GIST_ID}#file-resume-md`)
    await input.trigger('blur')

    expect(lastUpdate(wrapper)).toMatchObject({ gistId: GIST_ID, fileName: '' })
  })

  it('认不出来的输入被还原，不会把配置改坏', async () => {
    const { wrapper, input } = mountPicker({ gistId: GIST_ID })

    await input.setValue('随便打的字')
    await input.trigger('blur')

    expect(wrapper.emitted('update:config')).toBeUndefined()
    expect((input.element as HTMLInputElement).value).toBe(GIST_ID)
  })

  it('输入框里输入 token 会写回配置', async () => {
    const { wrapper, tokenInput } = mountPicker({ gistId: GIST_ID })

    await tokenInput.setValue('ghp_pasted')

    expect(lastUpdate(wrapper)).toMatchObject({ token: 'ghp_pasted' })
  })

  it('10 分钟内已经同步过同一份内容时，不再自动重复取', async () => {
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'))
    const { wrapper } = mountPicker(
      { gistId: GIST_ID },
      {
        syncedAt: new Date('2026-03-01T11:55:00Z').toISOString(), // 5 分钟前
        syncedFrom: sourceKey(GIST_ID),
      },
    )

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('10 分钟内已同步过')
  })

  it('超过 10 分钟后照常自动同步', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'))

    mountPicker(
      { gistId: GIST_ID },
      {
        syncedAt: new Date('2026-03-01T11:49:00Z').toISOString(),
        syncedFrom: sourceKey(GIST_ID),
      },
    )

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).toHaveBeenCalledTimes(1)
  })

  it('换了 Gist 就不受间隔限制（旧时间不属于新内容）', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'))

    mountPicker(
      { gistId: 'bb5a315d61ae9438b18d' },
      {
        syncedAt: new Date('2026-03-01T11:59:00Z').toISOString(), // 1 分钟前，但属于另一个 Gist
        syncedFrom: sourceKey(GIST_ID),
      },
    )

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).toHaveBeenCalledTimes(1)
  })

  it('没有来源记录时（旧数据）不拿旧时间去挡', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'))

    mountPicker(
      { gistId: GIST_ID },
      { syncedAt: new Date('2026-03-01T11:59:00Z').toISOString() },
    )

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)

    expect(callBackground).toHaveBeenCalledTimes(1)
  })

  it('手动点「同步简历」不受 10 分钟限制', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'))

    const { wrapper } = mountPicker(
      { gistId: GIST_ID },
      {
        syncedAt: new Date('2026-03-01T11:59:00Z').toISOString(),
        syncedFrom: sourceKey(GIST_ID),
      },
    )
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3)
    expect(callBackground).not.toHaveBeenCalled()

    await wrapper.get('button').trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    expect(callBackground).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('已同步 3 字')
  })

  it('同步成功时把来源一起交给调用方（间隔判断要靠它）', async () => {
    vi.mocked(callBackground).mockResolvedValue(okFetch())

    const { wrapper } = mountPicker({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(wrapper.emitted('synced')?.[0]).toEqual([
      { markdown: '# 我', gistId: GIST_ID, fileName: 'resume.md' },
    ])
  })

  it('同步失败时把后台的理由显示出来', async () => {
    vi.mocked(callBackground).mockResolvedValue({
      ok: false,
      error: '取不到这个 Gist（404）：ID 写错了，或者它已经被删除',
    })

    const { wrapper } = mountPicker({ gistId: GIST_ID })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(wrapper.text()).toContain('同步失败')
    expect(wrapper.text()).toContain('404')
    expect(wrapper.emitted('synced')).toBeUndefined()
  })
})
