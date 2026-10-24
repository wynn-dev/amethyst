import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineProject } from 'vitest/config'

// Node by default; renderer component tests opt into a DOM with `// @vitest-environment happy-dom`.
export default defineProject({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src/renderer/src'),
      '@shared': resolve(import.meta.dirname, 'src/shared'),
    },
  },
  test: {
    name: 'desktop',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
