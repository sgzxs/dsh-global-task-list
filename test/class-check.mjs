// CSS-module contract test: every `css.<name>` the renderers reference must be
// defined, and every defined class must be referenced.
//
//   node test/class-check.mjs [panel.module.css panel.tsx surface.tsx]
//
// Neither side is typed — the class map is a plain object — so a typo on either
// side silently renders an unstyled element instead of failing.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = join(ROOT, 'src', 'client')

const args = process.argv.slice(2)
const cssPath = args[0] ?? join(clientDir, 'TaskUiPanel.module.css')
const renderers = args.slice(1).length > 0
  ? args.slice(1)
  : ['TaskUiPanel.tsx', 'surface.tsx'].map((name) => join(clientDir, name))

// Strip comments first: prose in a header comment can otherwise look like a
// selector, and a commented-out `css.foo` like a usage.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const defined = new Set(
  [...stripComments(readFileSync(cssPath, 'utf8')).matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]),
)

const used = new Set()
for (const path of renderers) {
  for (const m of stripComments(readFileSync(path, 'utf8')).matchAll(/\bcss\.([A-Za-z][A-Za-z0-9_]*)/g)) used.add(m[1])
}

const missing = [...used].filter((name) => !defined.has(name)).sort()
const unused = [...defined].filter((name) => !used.has(name)).sort()

console.log(`classes defined      : ${defined.size}`)
console.log(`classes referenced   : ${used.size}`)
console.log(`referenced, undefined: ${missing.length === 0 ? 'none' : missing.join(', ')}`)
console.log(`defined, unreferenced: ${unused.length === 0 ? 'none' : unused.join(', ')}`)

const ok = missing.length === 0 && unused.length === 0
console.log(ok ? '\nCLASSES: PASS' : '\nCLASSES: FAIL')
process.exit(ok ? 0 : 1)
