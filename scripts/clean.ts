import { readdir, rm } from 'node:fs/promises'
import { r } from './utils'

async function clean() {
  await Promise.all([
    rm(r('extension/dist'), { recursive: true, force: true }),
    rm(r('extension/manifest.json'), { force: true }),
  ])

  // 根目录下的 extension.zip / extension.crx / extension.xpi 等产物
  // （不用 glob：跨 shell 的未匹配通配符行为不一致，CI 上会直接报错退出）
  const rootEntries = await readdir(r())
  const extensionArtifacts = rootEntries.filter(name => name.startsWith('extension.'))
  await Promise.all(
    extensionArtifacts.map(name => rm(r(name), { recursive: true, force: true })),
  )
}

clean()
