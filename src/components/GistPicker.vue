<script setup lang="ts">
import type { GistSource } from '~/logic/types'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { callBackground } from '~/logic/messaging'
import { parseGistId } from '~/platform/gist/gist'

/**
 * Gist 简历来源的配置面板。
 *
 * 交互只有一件事：**填 Gist 链接或 ID，内容自动同步**。
 *
 * 刻意不做「拉取我的 Gist 列表」那一套：读一个 Gist 本来就不需要任何权限
 * （secret Gist 也是 —— 它是「不被列出」而不是「要授权」），而列出列表才需要
 * 带 `gist` 权限的 token，且那条路极容易变成幻觉：凭据权限不够时 GitHub 不报错，
 * 而是按匿名请求返回全站公开 Gist，表现成「只拉到了公开的」。为了少一个字段、
 * 也为了不替用户保管 GitHub 凭据，这里只留 ID 输入。
 *
 * 三个不显眼但重要的决定：
 *
 * 1. **列表由后台代取**（见 background/main.ts 的 onGistFetch）：扩展页面侧不发跨源请求。
 * 2. **配置一变化就自动同步**：改 ID、换文件、甚至只是切到这个标签页，内容都该是新的。
 *    用 syncedKeys 记住「已经同步过的组合」，否则「同步 → 回写文件名 → 再同步」会成回环；
 *    另外同一个 Gist 在 10 分钟内只自动取一次，免得来回开关设置页白白烧 GitHub 额度。
 * 3. **输入框失焦（或回车）时才提交**，而不是边打边发请求 —— ID 是敲进去的，
 *    每敲一个字符就请求一次会连吃一串 404。
 */

const props = defineProps<{
  config: GistSource
  /** 最近一次同步成功的时间（存在简历上，跨页面/跨设备都看得到） */
  syncedAt: string | null
  /** 上面那个时间属于哪一份内容，形如 `<gistId>|<fileName>`；对不上就不能用来判断间隔 */
  syncedFrom: string | null
}>()

const emit = defineEmits<{
  'update:config': [value: GistSource]
  /** 同步成功：内容与来源交给调用方写进简历 */
  'synced': [value: { markdown: string, gistId: string, fileName: string }]
}>()

function update(patch: Partial<GistSource>): void {
  emit('update:config', { ...props.config, ...patch })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// 输入框
// ---------------------------------------------------------------------------

/** 输入框里的文字：既能是链接，也能是裸 ID */
const input = ref('')
/** 已经成功取到的文件列表，用来提供「换一个文件」 */
const files = ref<string[]>([])

/** 可选 token 的双向绑定（写回配置，交给父组件的 v-model:config） */
const token = computed({
  get: () => props.config.token,
  set: value => update({ token: value }),
})

/**
 * 输入框里显示的应该是规范化后的 ID（用户可能粘的是链接）。
 *
 * 只在 gistId 变化时同步输入框，用户正在打字时不动它。
 */
watch(() => props.config.gistId, (gistId) => {
  if (parseGistId(input.value) !== gistId)
    input.value = gistId
}, { immediate: true })

/**
 * 提交输入框。
 *
 * 认得出 ID 就写进配置（watch 会去同步）；认不出来时把输入框还原成已有的配置，
 * 不去改配置 —— 悄悄清掉一个填好的 ID 比留着旧值更糟。
 */
function commitInput(): void {
  const id = parseGistId(input.value)

  if (id === props.config.gistId) {
    input.value = props.config.gistId
    return
  }

  if (id) {
    // 换 Gist：清掉文件名（让它按新 Gist 重新自动挑），也清掉旧的文件列表
    files.value = []
    update({ gistId: id, fileName: '' })
    return
  }

  input.value = props.config.gistId
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    commitInput()
  }
}

// ---------------------------------------------------------------------------
// 同步
// ---------------------------------------------------------------------------

const syncStatus = ref<'idle' | 'syncing' | 'ok' | 'fail' | 'skipped'>('idle')
const syncError = ref('')
const syncMessage = ref('')

/** 本页面会话里已经同步过的「Gist + 文件」组合 */
const syncedKeys = new Set<string>()

/** 最近一次同步成功的「Gist + 文件」与时间，供自动同步的间隔判断使用 */
let lastSyncKey = ''
let lastSyncAt = 0

/** 一份内容的标识：同一个 Gist 的同一个文件才算同一份 */
function sourceKey(gistId: string, fileName: string): string {
  return `${gistId}|${fileName}`
}

async function sync(source: GistSource = props.config): Promise<void> {
  const gistId = parseGistId(source.gistId)
  if (!gistId) {
    syncStatus.value = 'fail'
    syncError.value = '请先填写 Gist 链接或 ID'
    return
  }

  syncStatus.value = 'syncing'
  syncError.value = ''

  try {
    const res = await callBackground<
      | { ok: true, gistId: string, fileName: string, markdown: string, files: string[] }
      | { ok: false, error: string }
    >('gist-fetch', { gistId, fileName: source.fileName, token: source.token.trim() })

    if (!res.ok)
      throw new Error(res.error)

    emit('synced', { markdown: res.markdown, gistId: res.gistId, fileName: res.fileName })
    files.value = res.files
    syncMessage.value = `已同步 ${res.markdown.length} 字 · 文件 ${res.fileName}`
    syncStatus.value = 'ok'
    // 记下这次取的是哪份内容、什么时候取的，供自动同步的间隔判断使用
    lastSyncKey = sourceKey(res.gistId, res.fileName)
    lastSyncAt = Date.now()

    // 把这次实际用的 Gist / 文件记下来：下次（换设备也一样）不必再猜。
    // 但要先把规范化后的组合标成「已同步」，否则 watch 会把这次回写当成新变化再来一遍。
    const patch: Partial<GistSource> = {}
    if (props.config.gistId !== res.gistId)
      patch.gistId = res.gistId
    if (props.config.fileName !== res.fileName)
      patch.fileName = res.fileName

    if (Object.keys(patch).length > 0) {
      syncedKeys.add(sourceKey(res.gistId, res.fileName))
      update(patch)
    }
  }
  catch (error) {
    syncStatus.value = 'fail'
    syncError.value = errorText(error)
  }
}

/** 换文件：写进配置即可，watch 会重新同步 */
function onPickFile(event: Event): void {
  update({ fileName: (event.target as HTMLSelectElement).value })
}

/**
 * 配置齐了就自动同步一次。
 *
 * 写 `immediate`：设置页每次打开、以及刚填完 ID / 换了文件时都会走到这里。
 * 存储还没读出来时 gistId 是空的，会被 parseGistId 挡掉（不报错、不改状态），
 * 等 useStoredValue 把值填进来，watch 会再触发一次。
 *
 * 防抖是必须的：换文件会连着改 fileName，用户也可能来回改输入框，
 * 不值得每个中间态都发一次请求。
 */
const AUTO_SYNC_DEBOUNCE_MS = 400

/**
 * 自动同步的最小间隔。
 *
 * 每次打开设置页都会走到这里，但**同一份内容**没必要反复取：简历一天改一两次，
 * 而 GitHub 对匿名请求限每小时 60 次 —— 反复开关设置页就会白白烧额度。
 * 所以同一个「Gist + 文件」在 10 分钟内只自动取一次（手动点「同步简历」不受限制）。
 * 换了 Gist 或换了文件，key 就变了，属于「另一份内容」，立刻取。
 */
const AUTO_SYNC_MIN_INTERVAL_MS = 10 * 60 * 1000

let autoSyncTimer: ReturnType<typeof setTimeout> | null = null

function runAutoSync(): void {
  autoSyncTimer = null

  const gistId = parseGistId(props.config.gistId)
  if (!gistId)
    return

  const key = sourceKey(gistId, props.config.fileName)
  if (syncedKeys.has(key))
    return

  // 用存下来的时间播种，但**只在它确实属于当前这份内容时**才算数：
  // 换了 Gist 之后 syncedFrom 是旧的，那就该立刻去取新的。
  if (!lastSyncKey && props.syncedFrom === key) {
    const stored = Date.parse(props.syncedAt ?? '')
    if (Number.isFinite(stored)) {
      lastSyncKey = key
      lastSyncAt = stored
    }
  }

  if (key === lastSyncKey && Date.now() - lastSyncAt < AUTO_SYNC_MIN_INTERVAL_MS) {
    syncStatus.value = 'skipped'
    return
  }

  syncedKeys.add(key)
  void sync()
}

watch(
  () => [props.config.gistId, props.config.fileName] as const,
  () => {
    if (autoSyncTimer)
      clearTimeout(autoSyncTimer)
    autoSyncTimer = setTimeout(runAutoSync, AUTO_SYNC_DEBOUNCE_MS)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (autoSyncTimer)
    clearTimeout(autoSyncTimer)
})

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/** 展示用：当前生效的文件名（同步成功后会回写成实际取到的那个） */
const activeFileName = computed(() => props.config.fileName)

function formatDateTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}
</script>

<template>
  <div class="space-y-3 rounded-lg border border-gray-200 p-4">
    <label class="block">
      <span class="mb-1 block text-sm text-gray-600">Gist 链接或 ID</span>
      <input
        v-model="input"
        class="oh-input font-mono"
        placeholder="https://gist.github.com/user/&lt;id&gt; 或直接填 ID"
        autocomplete="off"
        spellcheck="false"
        @blur="commitInput"
        @keydown="onKeydown"
      >
      <span class="mt-1 block text-xs text-gray-400">
        填链接或 ID 即自动同步，不需要 token。粘链接会自动取出其中的 ID。
      </span>
      <span class="mt-1 block text-xs text-amber-700">
        ⚠ Secret Gist 只是不被列出，拿到链接的人都能读，请妥善保管。
      </span>
    </label>

    <label class="block">
      <span class="mb-1 flex items-center gap-2 text-sm text-gray-600">
        <span>Personal access token</span>
        <span class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">可选</span>
      </span>
      <input
        v-model="token"
        type="password"
        class="oh-input font-mono"
        placeholder="ghp_… / github_pat_…"
        autocomplete="off"
        spellcheck="false"
      >
      <span class="mt-1 block text-xs text-gray-400">
        填不填都能同步；填上只为提高额度：匿名 60 次/小时 → 5000 次/小时。
      </span>
      <span class="mt-1 block text-xs text-amber-700">
        ⚠ 明文存在本机。
      </span>
    </label>

    <label v-if="files.length > 1" class="block">
      <span class="mb-1 block text-sm text-gray-600">同步哪个文件</span>
      <select
        class="oh-input"
        :value="activeFileName"
        @change="onPickFile"
      >
        <option v-for="name in files" :key="name" :value="name">
          {{ name }}
        </option>
      </select>
      <span class="mt-1 block text-xs text-gray-400">
        默认挑最像简历的（优先 .md）。
      </span>
    </label>

    <div class="flex flex-wrap items-center gap-3">
      <button
        type="button"
        class="oh-btn-primary"
        :disabled="syncStatus === 'syncing'"
        @click="sync()"
      >
        {{ syncStatus === 'syncing' ? '同步中…' : '同步简历' }}
      </button>
      <span v-if="syncedAt" class="text-xs text-gray-400">
        上次同步：{{ formatDateTime(syncedAt) }}
      </span>
    </div>

    <p
      v-if="syncStatus === 'ok'"
      class="flex items-start gap-1.5 rounded border border-teal-200 bg-teal-50 p-2 text-xs text-teal-800"
    >
      <span class="i-tabler-circle-check mt-[1px] shrink-0 text-sm" />
      <span class="min-w-0 break-all">{{ syncMessage }}</span>
    </p>
    <p
      v-else-if="syncStatus === 'fail'"
      class="flex items-start gap-1.5 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700"
    >
      <span class="i-tabler-alert-triangle mt-[1px] shrink-0 text-sm" />
      <span class="min-w-0 break-all">同步失败：{{ syncError }}</span>
    </p>
    <p v-else-if="syncStatus === 'skipped'" class="text-xs text-gray-400">
      10 分钟内已同步过，跳过自动刷新；要立刻取最新内容就点「同步简历」。
    </p>
  </div>
</template>

<style scoped>
/* 与设置页其它表单保持一致的输入框 / 主按钮（scoped 样式不跨组件，只能自带一份） */
.oh-input {
  width: 100%;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  padding: 0.4rem 0.6rem;
  font-size: 0.875rem;
  background: #fff;
  outline: none;
  transition: border-color 0.15s;
}
.oh-input:focus {
  border-color: #0d9488;
  box-shadow: 0 0 0 2px rgba(13, 148, 136, 0.15);
}
.oh-btn-primary {
  background: #0d9488;
  border: none;
  border-radius: 0.375rem;
  padding: 0.4rem 1rem;
  color: #fff;
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 0.15s;
}
.oh-btn-primary:hover:not(:disabled) {
  background: #0f766e;
}
.oh-btn-primary:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
