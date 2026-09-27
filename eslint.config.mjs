import antfu from '@antfu/eslint-config'

export default antfu(
  {
    ignores: [
      // 由 unplugin 在构建时生成
      'src/auto-imports.d.ts',
      'src/components.d.ts',
      // 构建产物
      'extension/**',
      // Playwright 的运行产物（e2e 之后会生成，不是源码）
      'test-results/**',
      'playwright-report/**',
    ],
  },
)
