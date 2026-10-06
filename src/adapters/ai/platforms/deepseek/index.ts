import { createOpenAIProtocol } from '../../protocols/openai'
import { defineAiPlatform } from '../types'

/**
 * DeepSeek：OpenAI 兼容 wire 格式。
 *
 * ⚠ 模型名随版本变动，务必以官方文档为准：
 *  - 当前：`deepseek-flash`（DeepSeek-V4.1-Flash）、`deepseek-v4-pro`
 *  - `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停止服务，
 *    用它们会直接报模型不存在
 *
 * ⚠ 自 V4 起**思考模式默认开启**（effort 默认 high）。思考内容会先消耗 token
 * 预算，导致 content 为空、答案只在 reasoning_content 里 —— 这正是
 * 「连接测试正常但回显空」「报模型返回了空内容」的根因。
 * 本项目场景（匹配打分、招呼语生成）都是短输出，因此默认关闭思考。
 *
 * 能力：只有 json_object（无 json_schema），且要求 prompt 中出现 "json" 字样。
 */
export default defineAiPlatform({
  id: 'deepseek',
  providerName: 'DeepSeek',
  protocol: createOpenAIProtocol(),
  defaultBaseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-flash',
  capabilities: { structuredOutput: 'json_object', maxInputChars: 60_000 },
  thinkingToggle: true,
  label: 'DeepSeek',
  hint: '中文好、价格低',
})
