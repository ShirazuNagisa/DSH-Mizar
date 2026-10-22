// Bundle the upstream pure accounting fold, not its Cordis plugin, into the
// published package. Production must not rely on the host's node_modules layout.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
await build({
  stdin: {
    contents: "export { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'",
    resolveDir: root,
    sourcefile: 'turn-usage-entry.js',
    loader: 'js',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: new URL('../lib/bridge/turn-usage-fold.js', import.meta.url).pathname,
})
