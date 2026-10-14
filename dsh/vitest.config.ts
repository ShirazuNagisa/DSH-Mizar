import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration.
 *
 * The only thing that needs setting is JSX: the browser half is `.tsx` and is
 * tested by rendering it, so Vitest has to transform JSX the same way the bundle
 * builder does. Everything else uses Vitest's defaults.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
})
