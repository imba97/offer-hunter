import type { Buffer } from 'node:buffer'
import { access, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import sharp from 'sharp'
import { log, r } from './utils'

/**
 * 从一张源图生成扩展用到的全部图标，直接覆盖现有文件。
 *
 * ```bash
 * pnpm exec esno scripts/icons.ts ./new-logo.png
 * ```
 *
 * 每个尺寸都是三步：
 *  1. `trim` —— 按 alpha 包围盒裁掉四周空白。这样源图的留白多少都不影响成品，
 *     图形总能填满图标（源图留白不一致是最容易出现「同一个 logo 大小不一样」的原因）。
 *  2. `resize(inner, inner, { fit: 'contain' })` —— 等比缩进 `size × (1 - 2×PAD)` 的方框并居中，
 *     非等比的那一边自动留白。
 *  3. `extend` —— 补透明边到 `size × size`，让图形与图标边缘保持一点距离（贴边的图标在工具栏里会显得过大）。
 *
 * 产物：`extension/assets/icon-{16,32,48,128,512}.png` 与 `src/assets/logo.png`
 * （后者是设置页头部用的那份，内容与 128 图标一致）。
 *
 * ⚠ 源图要有真正的 alpha 通道。若背景是一层「画进像素里的棋盘格」（有些 AI 出图工具会这样），
 * 抠不掉：脚本只能按 alpha 判断，检测不到 alpha 时会警告。
 */

/** 需要的尺寸。16/32/48 是浏览器工具栏与扩展管理页，128 是商店/详情页，512 是 README 与动作图标 */
const SIZES = [16, 32, 48, 128, 512]

/** 四周留白比例（占单边尺寸） */
const PAD_RATIO = 0.04

/** trim 的容差，等价于「alpha 大于多少才算内容」 */
const TRIM_THRESHOLD = 8

/** 设置页头部 logo 用哪个尺寸生成 */
const LOGO_SIZE = 128

/** 全透明，用于 resize 与 extend 的留白 */
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }

async function renderIcon(source: string, size: number): Promise<Buffer> {
  const pad = Math.max(1, Math.round(size * PAD_RATIO))
  const inner = size - pad * 2

  return sharp(source)
    .trim({ threshold: TRIM_THRESHOLD })
    .resize(inner, inner, {
      fit: 'contain',
      kernel: 'lanczos3',
      background: TRANSPARENT,
    })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: TRANSPARENT })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

async function main() {
  const input = process.argv[2]
  if (!input) {
    console.error('用法：pnpm exec esno scripts/icons.ts <源图路径>')
    process.exit(1)
  }

  const source = resolve(input)
  try {
    await access(source)
  }
  catch {
    console.error(`找不到源图：${source}`)
    process.exit(1)
  }

  const meta = await sharp(source).metadata()
  log('ICON', `源图 ${relative(r(), source)} · ${meta.width}x${meta.height} · ${meta.format}`)

  if (!meta.hasAlpha)
    log('ICON', '⚠ 源图没有 alpha 通道，背景不会被抠掉；请换一张带透明背景的 PNG')

  const targets = [
    ...SIZES.map(size => ({ size, path: r(`extension/assets/icon-${size}.png`) })),
    { size: LOGO_SIZE, path: r('src/assets/logo.png') },
  ]

  for (const target of targets) {
    const buffer = await renderIcon(source, target.size)
    await writeFile(target.path, buffer)
    log('ICON', `${relative(r(), target.path)}  ${target.size}×${target.size}  ${(buffer.length / 1024).toFixed(1)} KB`)
  }

  log('ICON', '完成。图标是静态文件、不参与构建，所以提交后无需重新构建扩展')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
