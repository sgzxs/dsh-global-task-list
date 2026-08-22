import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))
const DST = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-global-task-list')

await rm(DST, { recursive: true, force: true })
await mkdir(DST, { recursive: true })

for (const entry of ['package.json', 'cordis.patch.yml', 'lib', 'src', 'tsdown.config.mjs', 'skills']) {
  await cp(join(SRC, entry), join(DST, entry), { recursive: true })
}

await rm(join(DST, 'node_modules'), { recursive: true, force: true })

console.log(`synced -> ${DST}`)
console.log((await readdir(DST)).sort().join('\n'))
