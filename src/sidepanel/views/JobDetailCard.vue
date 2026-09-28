<script setup lang="ts">
import type { JobRecord, JobView } from '~/logic/types'
import { computed, ref } from 'vue'
import ScrollArea from '~/components/ScrollArea.vue'
import { createEmptyJobView } from '~/logic/types'

/**
 * 当前岗位的详情卡：展示岗位信息与 JD，并提供「匹配 → 生成招呼语 → 复制」三步操作。
 *
 * 扩展**不代填、不代发**：招呼语只生成到用户剪贴板，由用户自己粘贴发送。
 */

/**
 * 全部 props 都给默认值。
 *
 * 原因是这类组件的失败模式特别糟：漏传一个 prop 不会报编译错，而是渲染期抛
 * "Cannot read properties of undefined"，导致整块面板白屏且没有任何提示。
 * 给默认值可以退化成空状态，至少是可见、可诊断的。
 */
const props = withDefaults(defineProps<{
  job?: JobView
  record?: JobRecord | null
  busy?: { matching: boolean, greeting: boolean }
}>(), {
  // 空岗位视图统一由 createEmptyJobView 造，避免 22 个字段在多处各写一遍
  job: () => createEmptyJobView({ source: 'api' }),
  record: null,
  busy: () => ({ matching: false, greeting: false }),
})

defineEmits<{
  match: []
  greeting: []
  copy: []
}>()

const showJd = ref(false)

const match = computed(() => props.record?.match ?? null)
const greeting = computed(() => props.record?.greeting ?? null)
const error = computed(() => props.record?.error ?? null)

const scoreColor = computed(() => {
  const s = match.value?.score
  if (s == null)
    return 'text-gray-400'
  if (s >= 85)
    return 'text-teal-700'
  if (s >= 75)
    return 'text-teal-600'
  if (s >= 60)
    return 'text-amber-600'
  return 'text-red-500'
})

const location = computed(() =>
  [props.job.cityName, props.job.areaDistrict, props.job.businessDistrict]
    .filter(Boolean)
    .join(' · '),
)

const companyLine = computed(() =>
  [props.job.brandName, props.job.brandStageName, props.job.brandScaleName, props.job.brandIndustry]
    .filter(Boolean)
    .join(' · '),
)

/** 逐个字段兜底：接口字段缺失时退化成空数组，而不是让整块面板白屏 */
const skills = computed(() => Array.isArray(props.job.skills) ? props.job.skills : [])

const jdText = computed(() => props.job.jdText ?? '')

const jdLines = computed(() => jdText.value.split('\n').filter(l => l.trim().length > 0))
</script>

<template>
  <article class="space-y-3">
    <!-- 岗位头部 -->
    <header class="rounded-lg border border-gray-200 p-3">
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-semibold text-gray-800">
            {{ job.jobName }}
          </h2>
          <p v-if="job.salaryDesc" class="mt-1 text-sm font-medium text-teal-700">
            {{ job.salaryDesc }}
          </p>
          <div class="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-gray-500">
            <span v-if="location">{{ location }}</span>
            <span v-if="job.jobExperience">{{ job.jobExperience }}</span>
            <span v-if="job.jobDegree">{{ job.jobDegree }}</span>
          </div>
        </div>

        <!--
          分数右侧只有数字，不放「已跳过 / 已生成」这类状态字样：
          那是自动化流程的产物，现在每一步都由用户自己决定，状态既无消费方也无意义。
        -->
        <div v-if="match" class="shrink-0 text-right">
          <div class="text-2xl font-semibold leading-none" :class="scoreColor">
            {{ match.score }}
          </div>
        </div>
      </div>

      <div v-if="companyLine" class="mt-2 border-t border-gray-100 pt-2 text-xs text-gray-500">
        {{ companyLine }}
      </div>
      <div v-if="job.bossName" class="mt-0.5 text-xs text-gray-500">
        招聘者：{{ job.bossName }}
        <span v-if="job.bossTitle">（{{ job.bossTitle }}）</span>
        <span v-if="job.bossOnline" class="text-teal-600"> · 在线</span>
      </div>
    </header>

    <!-- 技能标签 -->
    <div v-if="skills.length" class="flex flex-wrap gap-1">
      <span
        v-for="s in skills"
        :key="s"
        class="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600"
      >
        {{ s }}
      </span>
    </div>

    <!-- JD -->
    <section class="rounded-lg border border-gray-200">
      <button
        class="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-gray-700"
        @click="showJd = !showJd"
      >
        <span>岗位描述（{{ jdText.length }} 字）</span>
        <span class="text-gray-400">{{ showJd ? '收起' : '展开' }}</span>
      </button>
      <!--
        JD 通常比面板长得多，这里限高 + 内部滚动。
        滚动条由 ScrollArea 自绘（原生滚动条会占宽，把文字挤窄、还会随内容长短抽动）。

        ⚠ `max-h-64` 只给上限，**不给高度**：ScrollArea 内部那层是绝对定位，撑不出高度，
        只有 max-height 时它就塌成 1px（文字只剩半行，踩过）。所以再用 `min-h-40` 定个下限，
        内容比它长就滚、比它短就是这个高度。

        ⚠ 右侧留白必须加在**滚动层**上（内部那一层），不能加在根节点：
        内部那层是 `inset: 0` 绝对定位的，实测会铺满根节点的 border box，
        根节点上的 `pr-*` 一点都换不来让位空间 —— 文字末尾会被滚动条压住约 7px。
        而给滚动层加 padding 只能用 `:deep()`（`scrollerClass` 传本文件的 scoped 类名不会生效，
        它带的是 ScrollArea 自己的 hash），见 components/README.md。
      -->
      <ScrollArea
        v-if="showJd"
        class="oh-jd max-h-64 min-h-40 border-t border-gray-100"
      >
        <p v-if="!jdLines.length" class="text-xs text-gray-400">
          没有读到 JD 内容
        </p>
        <p v-for="(line, i) in jdLines" :key="i" class="mb-1 text-xs leading-relaxed text-gray-600">
          {{ line }}
        </p>
      </ScrollArea>
    </section>

    <!-- 匹配结论 -->
    <section v-if="match" class="rounded-lg bg-gray-50 p-3 text-xs">
      <p class="font-medium text-gray-700">
        {{ match.summary }}
      </p>
      <ul v-if="match.reasons?.length" class="mt-1.5 list-inside list-disc space-y-0.5 text-gray-600">
        <li v-for="(r, i) in match.reasons" :key="i">
          {{ r }}
        </li>
      </ul>
      <p v-if="match.missingSkills?.length" class="mt-1.5 text-amber-700">
        缺失：{{ match.missingSkills.join('、') }}
      </p>
      <p v-if="match.truncated" class="mt-1.5 text-amber-700">
        简历或 JD 超出该平台的输入上限、已截断，评分可能受影响。
      </p>
    </section>

    <!-- 错误 -->
    <p v-if="error" class="rounded-lg bg-red-50 p-2.5 text-xs text-red-600">
      {{ error }}
    </p>

    <!-- 招呼语 -->
    <section v-if="greeting" class="rounded-lg bg-teal-50 p-3 text-xs">
      <div class="mb-1.5 flex items-center justify-between">
        <span class="font-medium text-teal-700">打招呼内容</span>
        <button class="text-teal-700 hover:underline" @click="$emit('copy')">
          复制
        </button>
      </div>
      <p class="whitespace-pre-wrap text-gray-700">
        {{ greeting }}
      </p>
    </section>

    <!-- 操作 -->
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <button class="oh-btn oh-btn-primary" :disabled="busy.matching" @click="$emit('match')">
        {{ busy.matching ? '分析中…' : (match ? '重新分析' : '匹配度分析') }}
      </button>

      <!--
        刻意不依赖 match：生成招呼语是独立能力，不该被「是否已分析」挡住。
        匹配结果是可选的加分项（有它会写得更贴合），没有也能生成。
      -->
      <button
        class="oh-btn"
        :disabled="busy.greeting"
        @click="$emit('greeting')"
      >
        {{ busy.greeting ? '生成中…' : (greeting ? '重新生成招呼语' : '生成招呼语') }}
      </button>
    </div>
  </article>
</template>

<style scoped>
/*
  JD 文本层：左右留白加在这里（而不是根节点），理由见模板里的注释。
  `pr` 取 16px：滚动条实际画在距右边缘 3–9px 处，16px 留白能让每行文字都躲开它。
*/
.oh-jd :deep(.oh-scroll-viewport) {
  padding: 0.5rem 1rem 0.5rem 0.75rem;
}

.oh-btn {
  padding: 0.35rem 0.75rem;
  border: 1px solid #d1d5db;
  border-radius: 0.25rem;
  background: #fff;
  color: #374151;
  cursor: pointer;
  transition: all 0.15s;
}
.oh-btn:hover:not(:disabled) {
  border-color: #0d9488;
  color: #0d9488;
}
.oh-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.oh-btn-primary {
  background: #0d9488;
  border-color: #0d9488;
  color: #fff;
}
.oh-btn-primary:hover:not(:disabled) {
  background: #0f766e;
  border-color: #0f766e;
  color: #fff;
}
</style>
