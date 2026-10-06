import { createOpenAIProtocol } from '../../protocols/openai'
import { defineAiPlatform } from '../types'

/** OpenAI：支持最严格的结构化输出（json_schema），可靠性最高 */
export default defineAiPlatform({
  id: 'openai',
  providerName: 'OpenAI',
  protocol: createOpenAIProtocol(),
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  capabilities: { structuredOutput: 'json_schema', maxInputChars: 100_000 },
  thinkingToggle: false,
  label: 'OpenAI',
  hint: '结果最稳定',
})
