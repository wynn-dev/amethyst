import { resolve } from 'node:path'
import { defineProject } from 'vitest/config'

export default defineProject({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    name: 'desktop',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
