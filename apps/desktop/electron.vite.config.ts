import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'

// Workspace packages ship TypeScript sources, so they must be bundled rather than externalized.
const workspacePackages = [
  '@amethyst/auth',
  '@amethyst/content',
  '@amethyst/game',
  '@amethyst/installer',
  '@amethyst/java',
  '@amethyst/marketplace',
  '@amethyst/modpack',
  '@amethyst/nbt',
  '@amethyst/net',
  '@amethyst/task',
  '@amethyst/telemetry',
  '@amethyst/zip',
]

const shared = resolve(import.meta.dirname, 'src/shared')

export default defineConfig({
  main: {
    // Build-time configuration (client IDs, API keys) is read from AMETHYST_* variables in the
    // environment or apps/desktop/.env.local and exposed only to the main process.
    envPrefix: 'AMETHYST_',
    resolve: { alias: { '@shared': shared } },
    build: {
      externalizeDeps: { exclude: workspacePackages },
      rollupOptions: {
        input: {
          // Electron main process: windows, menus, OS integration only.
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // Runtime utility process: every domain service.
          runtime: resolve(import.meta.dirname, 'src/runtime/index.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      externalizeDeps: { exclude: workspacePackages },
      // Sandboxed preload scripts must be CommonJS.
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, 'src/renderer/src'),
        '@shared': shared,
      },
    },
    plugins: [react(), tailwindcss()],
    build: { minify: true },
  },
})
