import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { getManifest } from '../src/manifest'
import { scanSiteDescriptors } from './site-descriptors'
import { log, r } from './utils'

/**
 * 生成 `extension/manifest.json`。
 *
 * ⚠ 站点清单必须在 Node 侧扫一遍（`scanSiteDescriptors()`）：manifest 生成器跑在
 *   Node 里，没有 Vite 的 `import.meta.glob`（见 site-descriptors.ts 的说明）。
 *   扫出来的列表**只在内存里传下去**，不落任何中间文件。
 *
 * ⚠ manifest 生成器（`src/manifest.ts`）自己**不 glob**：站点清单是作为参数传进去的。
 *   这样它既能在 Node 里跑，也能在测试里跑（测试自己 glob 一份传进去），而
 *   「谁扫目录」这件事在两边都是显式的。
 */
export async function writeManifest() {
  const descriptors = await scanSiteDescriptors()
  const manifest = await getManifest(descriptors)

  await mkdir(r('extension'), { recursive: true })
  await writeFile(
    r('extension/manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  )
  log('PRE', `write manifest.json（${descriptors.length} 个站点：${descriptors.map(d => d.id).join(', ')}）`)
}

writeManifest().catch((error) => {
  console.error(error)
  process.exit(1)
})
