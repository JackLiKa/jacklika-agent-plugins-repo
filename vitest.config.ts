import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
