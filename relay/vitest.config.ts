import { defineConfig } from 'vitest/config'

/** The relay has no browser half, so the only thing worth setting is the glob. */
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
})
