// `pnpm dist`: build and package the macOS arm64 app (dmg + zip) into apps/desktop/release.
//
// Without signing credentials (CSC_LINK or CSC_NAME) the build is unsigned: identity
// auto-discovery is turned off so a stray certificate in the local keychain is never used
// (set CSC_IDENTITY_AUTO_DISCOVERY=true to opt back in), and notarization is skipped.
// Extra arguments are passed to electron-builder.
import { spawnSync } from 'node:child_process'

const env = { ...process.env }
if (!env.CSC_LINK && !env.CSC_NAME && env.CSC_IDENTITY_AUTO_DISCOVERY === undefined) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  console.warn('dist: no CSC_LINK/CSC_NAME, building an unsigned app')
}

// `pnpm exec` resolves the local binaries whether or not this runs through `pnpm run`.
function exec(bin, args) {
  const result = spawnSync('pnpm', ['exec', bin, ...args], { stdio: 'inherit', env, cwd: new URL('..', import.meta.url) })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

exec('electron-vite', ['build'])
exec('electron-builder', ['--mac', '--arm64', '--publish', 'never', ...process.argv.slice(2)])
