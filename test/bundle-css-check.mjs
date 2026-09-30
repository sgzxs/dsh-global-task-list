// Verify the BUILT client bundle is internally consistent: every class the JS
// uses must have a rule in the CSS text the same bundle injects.
//
// The source-level class check compares `css.*` against the stylesheet, but the
// artifact a user actually installs is the bundle, and that is where a build can
// still drop or rename a rule. A class present in the map but absent from the
// emitted CSS renders as a completely unstyled element.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundlePath = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

// The bundle carries the stylesheet as one (escaped) string literal.
const cssMatch = source.match(/const css = "((?:[^"\\]|\\.)*)"/)
if (cssMatch === null) {
  console.log('ASSERT FAILED: the bundle carries no css string')
  process.exit(1)
}
const css = JSON.parse(`"${cssMatch[1]}"`)

// The exported class map, e.g.  "expandButton": "_5VO3Pq_expandButton",
const mapped = [...source.matchAll(/"([A-Za-z0-9_]+)":\s*"(_[A-Za-z0-9]+_[A-Za-z0-9_]+)"/g)]
  .map(([, key, name]) => ({ key, name }))

console.log(`bundle      : ${bundlePath}`)
console.log(`css bytes   : ${css.length}`)
console.log(`mapped keys : ${mapped.length}`)

const missingInCss = mapped.filter(({ name }) => !css.includes(`.${name}`))

// Every class rule in the CSS should also be reachable from the map.
const cssClasses = [...new Set([...css.matchAll(/\.(_[A-Za-z0-9]+_[A-Za-z0-9_]+)/g)].map((m) => m[1]))]
const mappedNames = new Set(mapped.map((m) => m.name))
const unreachable = cssClasses.filter((name) => !mappedNames.has(name))

console.log(`css classes : ${cssClasses.length}`)
console.log(`map -> css  : ${missingInCss.length === 0 ? 'all present' : missingInCss.map((m) => m.key).join(', ')}`)
console.log(`css -> map  : ${unreachable.length === 0 ? 'all reachable' : unreachable.join(', ')}`)

const failures = missingInCss.length + unreachable.length
console.log(failures === 0 ? '\nBUNDLE-CSS: PASS' : `\nBUNDLE-CSS: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
