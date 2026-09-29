// Local dev helper: copy the built plugin into a profile's node_modules so a
// running DSH picks it up on its next profile recompose (or restart).
//
//   node sync-profile.mjs [profile]      # profile defaults to "web"
//
// A profile only mounts the plugin when its package.json lists
// "dsh-global-task-list" in dsh.profile.bundles; the script warns when it does
// not, because the copy alone is not enough. This helper is not published (see
// package.json `files`) — `dsh plugin add` is the install path for users.
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))
const PROFILE = process.argv[2] ?? 'web'
const PROFILE_DIR = join(homedir(), '.dsh', 'profiles', PROFILE)
const DST = join(PROFILE_DIR, 'node_modules', 'dsh-global-task-list')

await rm(DST, { recursive: true, force: true })
await mkdir(DST, { recursive: true })

for (const entry of ['package.json', 'cordis.patch.yml', 'lib', 'src', 'tsdown.config.mjs', 'skills']) {
  await cp(join(SRC, entry), join(DST, entry), { recursive: true })
}

await rm(join(DST, 'node_modules'), { recursive: true, force: true })

console.log(`synced -> ${DST}`)
console.log((await readdir(DST)).sort().join('\n'))

try {
  const manifest = JSON.parse(await readFile(join(PROFILE_DIR, 'package.json'), 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes('dsh-global-task-list')) {
    console.warn(`\nWARNING: profile "${PROFILE}" does not list dsh-global-task-list in dsh.profile.bundles — the plugin will not mount.`)
  }
} catch (error) {
  console.warn(`\nWARNING: could not read ${join(PROFILE_DIR, 'package.json')}: ${String(error)}`)
}
