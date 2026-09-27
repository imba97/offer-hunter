import { defineConfig, presetAttributify, presetIcons, presetWind3, transformerDirectives } from 'unocss'

/**
 * UnoCSS 配置。
 *
 * 图标（`i-tabler-*`）由 `presetIcons` 解析：在 Node 环境下它会通过
 * `@iconify/utils` 的 node-loader 从已安装的 `@iconify-json/<集合>` 里按需取图标数据，
 * 只把用到的图标打进产物。
 *
 * ⚠ 不要自定义 `collections`：那会覆盖默认的 node-loader 行为，
 * 导致图标一个都生成不出来（踩过）。
 */
export default defineConfig({
  presets: [
    presetWind3(),
    presetAttributify(),
    presetIcons({
      // 面板里的图标尺寸偏小，统一基线大小与对齐方式
      scale: 1,
      extraProperties: {
        'display': 'inline-block',
        'vertical-align': 'middle',
      },
    }),
  ],
  transformers: [
    transformerDirectives(),
  ],
})
