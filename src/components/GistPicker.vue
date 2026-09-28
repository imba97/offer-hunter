<script setup lang="ts">
import type { ResumeContent, ResumeSourceAdapter } from '~/logic/resume-sources/types'
import { computed, ref, watch } from 'vue'
import { useResumeSourceSync } from '~/logic/resume-sources/useResumeSourceSync'
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
 * 同步编排（去抖 / 节流 / 状态机 / 经后台取数）已经抽到
 * logic/resume-sources/useResumeSourceSync —— 那部分与「是 Gist 还是 PDF」无关。
 * 本组件只保留 Gist 自己知道的东西：**输入框怎么规范化、文件怎么换**。
 *
 * 一个不显眼但重要的决定：**输入框失焦（或回车）时才提交**，而不是边打边发请求
 * —— ID 是敲进去的，每敲一个字符就请求一次会连吃一串 404。
 */

const props = defineProps<{
  /** 来源适配器（由注册表提供，这里只用来取 fetch/identify 与字段声明） */
  adapter: ResumeSourceAdapter
  config: Record<string, unknown>
  /** 最近一次同步成功的时间（存在简历上，跨页面/跨设备都看得到） */
  syncedAt: string | null
  /** 上面那个时间属于哪一份内容（适配器的 contentKey）；对不上就不能用来判断间隔 */
  syncedKey: string | null
}>()

const emit = defineEmits<{
  'update:config': [value: Record<string, unknown>]
  /** 同步成功：内容与标识交给调用方写进简历 */
  'synced': [value: { markdown: string, contentKey: string, label?: string }]
}>()

function update(patch: Record<string, unknown>): void {
  emit('update:config', { ...props.config, ...patch })
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// ---------------------------------------------------------------------------
// 输入框
// ---------------------------------------------------------------------------

/** 输入框里的文字：既能是链接，也能是裸 ID */
const input = ref('')
/** 输入无法识别时的就地提示（不动配置） */
const inputError = ref('')

/**
 * 输入框里显示的应该是规范化后的 ID（用户可能粘的是链接）。
 *
 * 只在 gistId 变化时同步输入框，用户正在打字时不动它。
 */
watch(() => str(props.config.gistId), (gistId) => {
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

  if (id === str(props.config.gistId)) {
    input.value = str(props.config.gistId)
    inputError.value = ''
    return
  }

  if (id) {
    inputError.value = ''
    // 换 Gist：清掉文件名（让它按新 Gist 重新自动挑），也清掉旧的文件列表
    update({ gistId: id, fileName: '' })
    return
  }

  input.value = str(props.config.gistId)
  inputError.value = input.value.trim()
    ? '认不出这是 Gist 链接或 ID，已保留原来的值'
    : ''
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    commitInput()
  }
}

// ---------------------------------------------------------------------------
// 同步（编排在 composable 里）
// ---------------------------------------------------------------------------

const { status, error, message, items, sync } = useResumeSourceSync({
  adapter: props.adapter,
  config: () => props.config,
  syncedAt: () => props.syncedAt,
  syncedKey: () => props.syncedKey,
  onSynced: handleSynced,
})

/**
 * 同步成功：把结果交给父组件写进简历，并把「实际取到的 gistId / 文件名」
 * 回写进配置 —— 下次（换设备也一样）不必再猜自动挑的是哪个文件。
 *
 * ⚠ 回写会改变配置，因此必须避免把自己再点着：composable 已经把这次的
 * contentKey 记进「本会话已同步」，所以配置变化触发的那次自动同步会直接返回，
 * 不会形成「同步 → 写回 → 同步」的回环。
 */
function handleSynced(content: ResumeContent): void {
  emit('synced', {
    markdown: content.markdown,
    contentKey: content.contentKey,
    label: content.label,
  })

  // 规范化：用户粘的是链接时，把收敛后的 ID 也落盘
  const gistId = parseGistId(str(props.config.gistId))
  const patch: Record<string, unknown> = {}
  if (gistId && gistId !== props.config.gistId)
    patch.gistId = gistId
  // 自动挑文件时用户没指定过文件名，把它记下来
  if (content.label && content.label !== props.config.fileName)
    patch.fileName = content.label

  if (Object.keys(patch).length > 0)
    update(patch)
}

/** 换文件：写进配置即可，watch 会重新同步 */
function onPickFile(event: Event): void {
  update({ fileName: (event.target as HTMLSelectElement).value })
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/** 展示用：当前生效的文件名（同步成功后会回写成实际取到的那个） */
const activeFileName = computed(() => str(props.config.fileName))

const token = computed({
  get: () => str(props.config.token),
  set: value => update({ token: value }),
})

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
      <span v-if="inputError" class="mt-1 block text-xs text-red-600">
        {{ inputError }}
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

    <label v-if="items.length > 1" class="block">
      <span class="mb-1 block text-sm text-gray-600">同步哪个文件</span>
      <select
        class="oh-input"
        :value="activeFileName"
        @change="onPickFile"
      >
        <option v-for="name in items" :key="name" :value="name">
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
        :disabled="status === 'syncing'"
        @click="sync()"
      >
        {{ status === 'syncing' ? '同步中…' : '同步简历' }}
      </button>
      <span v-if="syncedAt" class="text-xs text-gray-400">
        上次同步：{{ formatDateTime(syncedAt) }}
      </span>
    </div>

    <p
      v-if="status === 'ok'"
      class="flex items-start gap-1.5 rounded border border-teal-200 bg-teal-50 p-2 text-xs text-teal-800"
    >
      <span class="i-tabler-circle-check mt-[1px] shrink-0 text-sm" />
      <span class="min-w-0 break-all">{{ message }}</span>
    </p>
    <p
      v-else-if="status === 'fail'"
      class="flex items-start gap-1.5 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700"
    >
      <span class="i-tabler-alert-triangle mt-[1px] shrink-0 text-sm" />
      <span class="min-w-0 break-all">同步失败：{{ error }}</span>
    </p>
    <p v-else-if="status === 'skipped'" class="text-xs text-gray-400">
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
