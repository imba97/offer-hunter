<script setup lang="ts">
import type { ResumeConfigField, ResumeContent, ResumeSourceAdapter } from '~/adapters/resume-sources/types'
import { computed, ref, watch } from 'vue'
import { useResumeSourceSync } from '~/adapters/resume-sources/useResumeSourceSync'
import SecretInput from '~/components/SecretInput.vue'
import { str } from '~/logic/strings'

/**
 * 简历来源的**通用**配置面板。
 *
 * 它按适配器声明的数据渲染整个界面：
 *   configFields        输入框（text / secret）、说明、风险提示、「可选」徽标
 *   normalize           失焦/回车时收敛用户输入（Gist：链接 → ID）
 *   itemField + items   取完之后才出现的「换哪一份」下拉
 *   readonlyContent     交给设置页决定编辑器是否只读（这里不管编辑器）
 *
 * 于是**新增一个普通来源不再需要写任何组件** —— 这正是这个组件存在的理由：
 * 此前每个来源都要复制一份「输入框 + 同步按钮 + 上次同步时间 + 状态条」，
 * 复制出来的那份一定会和这份走偏。
 *
 * 三个刻意的交互决定：
 *  1. **失焦/回车才提交**，不是边打边发请求 —— ID 是敲进去的，每敲一个字符就
 *     请求一次会连吃一串 404。
 *  2. 输入收敛失败时**还原输入框、不改配置**：悄悄清掉一个填好的值更糟。
 *  3. 同步成功后把「实际用到的子项」回写进配置（itemField），换设备也不必再猜
 *     自动挑的是哪一份；回写不会把自己再点着（见 useResumeSourceSync 的说明）。
 */

const props = defineProps<{
  /** 来源适配器（由注册表提供） */
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

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------

/**
 * 输入框的本地文本。
 *
 * 与配置分开存，有两个理由：
 *  1. 输入收敛（normalize）在**失焦时**才做，而配置随时可能被同步结果回写
 *  2. 回写发生时不能把用户正在敲的字冲掉 —— 因此配一份 dirty 标记：
 *     正在编辑的字段不参与「配置 → 输入框」的同步（见 syncDrafts）
 */
const drafts = ref<Record<string, string>>({})

/** 用户正在编辑（已输入、尚未提交）的字段 */
const dirty = ref<Record<string, boolean>>({})

/** 每个字段的就地错误提示（认不出来的输入），不动配置 */
const fieldErrors = ref<Record<string, string>>({})

/** 上一次渲染的是哪个来源：换来源时要把编辑状态清空 */
let lastAdapterId = props.adapter.id

/**
 * 把配置里的值同步进输入框。
 *
 * ⚠ 只更新**不在编辑中**的字段：自动同步成功后会把实际取到的子项回写进配置，
 *   那会触发一次配置变化；若在这里整体覆盖，用户正在敲的 token 会被抹掉
 *   （这条规则来自原来那个 Gist 专用组件：它当时只对 gistId 做了这件事，
 *   现在对所有字段统一成立）。
 */
function syncDrafts(): void {
  const next: Record<string, string> = { ...drafts.value }
  for (const field of props.adapter.configFields) {
    if (dirty.value[field.key])
      continue
    next[field.key] = str(props.config[field.key])
  }
  drafts.value = next
}

watch(
  () => [props.adapter.id, JSON.stringify(props.config)] as const,
  // 换来源时把编辑状态重置，否则上一个来源的 dirty 会挡住新来源的初始值
  () => {
    if (props.adapter.id !== lastAdapterId) {
      lastAdapterId = props.adapter.id
      dirty.value = {}
      fieldErrors.value = {}
    }
    syncDrafts()
  },
  { immediate: true },
)

/** 用户开始输入：标记为编辑中，并清掉上一次的就地报错 */
function onInput(field: ResumeConfigField): void {
  dirty.value[field.key] = true
  fieldErrors.value[field.key] = ''
}

/**
 * 提交一个字段。
 *
 * 走适配器的 normalize（若有）：它拿到的是「哪个字段 + 这次输入」，返回要存的值，
 * 或者 null 表示认不出来。没实现 normalize 的来源表示输入原样存储。
 *
 * 两条通用联动（不需要来源自己记得）：
 *  1. 收敛后的值才是要存的值（用户粘链接、输入框回显 ID）
 *  2. 改了「取哪一份内容」的字段 → 上一份的子项选择不再适用，清掉让它重新自动挑
 */
function commit(field: ResumeConfigField): void {
  const raw = drafts.value[field.key] ?? ''
  const adapter = props.adapter

  /**
   * 提交后这个字段就不再是「编辑中」：此后配置再变（含自动同步回写）
   * 可以正常同步进输入框。
   */
  dirty.value[field.key] = false

  const normalized = adapter.normalize ? adapter.normalize(field.key, raw) : raw

  if (normalized === null) {
    // 认不出来：还原成配置里的值（而不是清空），并就地说明
    drafts.value[field.key] = str(props.config[field.key])
    fieldErrors.value[field.key] = raw.trim()
      ? '认不出这个输入，已保留原来的值'
      : ''
    return
  }

  fieldErrors.value[field.key] = ''
  // 收敛后的值也要写回输入框：用户粘的是链接时，输入框要显示收敛后的 ID
  drafts.value[field.key] = normalized

  const patch: Record<string, unknown> = {}
  if (normalized !== str(props.config[field.key]))
    patch[field.key] = normalized

  const itemField = adapter.itemField
  if (itemField && field.key !== itemField && Object.keys(patch).length > 0 && str(props.config[itemField]))
    patch[itemField] = ''

  if (Object.keys(patch).length > 0)
    update(patch)
}

function onKeydown(event: KeyboardEvent, field: ResumeConfigField): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    commit(field)
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
 * 同步成功：内容交给父组件写进简历，并把「实际取到的那一项」回写进配置。
 *
 * 回写会改配置，因此必须避免把自己再点着：composable 已经把这次的 contentKey
 * 记进「本会话已同步」，配置变化触发的那次自动同步会直接返回，不成回环。
 */
function handleSynced(content: ResumeContent): void {
  emit('synced', {
    markdown: content.markdown,
    contentKey: content.contentKey,
    label: content.label,
  })

  const field = props.adapter.itemField
  if (!field || !content.label)
    return
  if (content.label !== str(props.config[field]))
    update({ [field]: content.label })
}

/** 换一份内容：写进配置即可，watch 会带着新值重新同步 */
function onPickItem(event: Event): void {
  const field = props.adapter.itemField
  if (!field)
    return
  update({ [field]: (event.target as HTMLSelectElement).value })
}

/** 当前生效的子项（同步成功后会回写成实际取到的那个） */
const activeItem = computed(() => {
  const field = props.adapter.itemField
  return field ? str(props.config[field]) : ''
})

function formatDateTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}
</script>

<template>
  <div class="space-y-3 rounded-lg border border-gray-200 p-4">
    <!-- 表单：整块由 configFields 驱动，没有配置项的来源（手动输入）不渲染 -->
    <label v-for="field in adapter.configFields" :key="field.key" class="block">
      <span class="mb-1 flex items-center gap-2 text-sm text-gray-600">
        <span>{{ field.label }}</span>
        <span v-if="field.optional" class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">可选</span>
      </span>

      <SecretInput
        v-if="field.type === 'secret'"
        v-model="drafts[field.key]"
        class="font-mono"
        :placeholder="field.placeholder"
        @input="onInput(field)"
        @blur="commit(field)"
        @keydown="(e: KeyboardEvent) => onKeydown(e, field)"
      />
      <input
        v-else
        v-model="drafts[field.key]"
        class="oh-input"
        :placeholder="field.placeholder"
        @input="onInput(field)"
        @blur="commit(field)"
        @keydown="(e: KeyboardEvent) => onKeydown(e, field)"
      >

      <span v-if="field.hint" class="mt-1 block text-xs text-gray-400">{{ field.hint }}</span>
      <span v-if="field.warning" class="mt-1 block text-xs text-amber-700">⚠ {{ field.warning }}</span>
      <span v-if="fieldErrors[field.key]" class="mt-1 block text-xs text-red-600">
        {{ fieldErrors[field.key] }}
      </span>
    </label>

    <!-- 「取完之后才有的选择项」：items 由上一次同步带回，选中项写回 itemField -->
    <label v-if="adapter.itemField && items.length > 1" class="block">
      <span class="mb-1 block text-sm text-gray-600">{{ adapter.itemLabel ?? '同步哪一份' }}</span>
      <select class="oh-input" :value="activeItem" @change="onPickItem">
        <option v-for="item in items" :key="item" :value="item">
          {{ item }}
        </option>
      </select>
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
