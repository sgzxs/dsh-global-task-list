// Host-half build: TypeScript source (src/index.ts) -> ESM bundle (lib/index.js).
// Deliberately SEPARATE from tsdown.config.mjs (the client closure-factory
// bundle) — tsdown -c selects this file; the client build keeps its default.
// Runtime deps resolve from the profile node_modules chain and must NOT be
// inlined, so every @deepseek-ai/* import and zod stay external.
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-global-task-list/host',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: false,
  clean: false, // never wipe lib/client.js produced by the client build
  // @deepseek-ai/* (schemastery included) and zod are peer/deps resolved at
  // runtime from the profile node_modules chain — not inlined into the bundle.
  external: [/^@deepseek-ai\//, 'zod', '@deepseek-ai/schemastery'],
  outputOptions: {
    entryFileNames: 'index.js',
  },
})
