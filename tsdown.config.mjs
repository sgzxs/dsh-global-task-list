// tsdown config replicating deepseek-harness packages/client/tsdown.client.ts
// (clientConfig): CJS closure-factory bundle -> window.__ModuleLoader__.load,
// plus the dsh-css-modules-inline virtual-id plugin (lightningcss) and
// TS/TSX entry resolution.
// Source of truth: https://github.com/deepseek-ai/deepseek-harness
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const ID = 'dsh-global-task-list'

// PLATFORM_MODULES from packages/client/web/src/platform.ts
// (+ documented runtime-store exemption).
const EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

// Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
// (which requires @tsdown/css). The suffix matters: tsdown's guard matches ids
// ending in `.css`, so the virtual id must not.
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

// Resolve the client entry at config load so the same config serves the
// plain-JS panel today and the TS/TSX rewrite once it lands (prefer .tsx,
// then .ts, then the .js fallback).
function clientEntry() {
  const dir = fileURLToPath(new URL('./src/client/', import.meta.url))
  for (const name of ['index.tsx', 'index.ts', 'index.js']) {
    const candidate = resolvePath(dir, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`${ID}: no client entry found under src/client (expected index.tsx, index.ts or index.js)`)
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source, importer) {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: clientEntry() },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: EXTERNALS,
  // anything NOT in the loader module table must inline.
  noExternal: (id) => (EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    // CSS Modules: compile `*.module.css` with lightningcss at build time and
    // inline the hashed class map plus a <style data-plugin="<id>"> tag per
    // module file (idempotent under re-evaluation). Replicates the official
    // dsh-css-modules-inline plugin (resolveId + load).
    name: 'dsh-css-modules-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the physical stylesheet from Rolldown's watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      // One <style data-plugin> per module file; idempotent under re-evaluation.
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
        `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
        `  const tag = document.createElement('style');`,
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        `  tag.dataset.pluginCss = tagId;`,
        `  tag.textContent = css;`,
        `  document.head.appendChild(tag);`,
        `}`,
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
