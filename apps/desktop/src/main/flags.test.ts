import { describe, expect, it } from 'vitest'
import { DISABLE_UPDATES_FLAG, isSmokeRun, SMOKE_FLAG, updatesDisabled } from './flags'

describe('test-only switches', () => {
  const env = { AMETHYST_SMOKE: '1', AMETHYST_DISABLE_UPDATES: '1' }

  it('needs the command-line flag as well as the variable in a packaged build', () => {
    expect(isSmokeRun({ env, argv: ['/Applications/Amethyst.app/Contents/MacOS/Amethyst'], packaged: true })).toBe(false)
    expect(updatesDisabled({ env, argv: ['Amethyst'], packaged: true })).toBe(false)
    expect(isSmokeRun({ env, argv: ['Amethyst', SMOKE_FLAG], packaged: true })).toBe(true)
    expect(updatesDisabled({ env, argv: ['Amethyst', DISABLE_UPDATES_FLAG], packaged: true })).toBe(true)
  })

  it('never turns on from the flag alone', () => {
    expect(isSmokeRun({ env: {}, argv: ['Amethyst', SMOKE_FLAG], packaged: true })).toBe(false)
    expect(updatesDisabled({ env: {}, argv: ['Amethyst', DISABLE_UPDATES_FLAG], packaged: true })).toBe(false)
  })

  it('only needs the variable in an unpackaged (dev) run', () => {
    expect(isSmokeRun({ env, argv: ['electron', '.'], packaged: false })).toBe(true)
    expect(isSmokeRun({ env: {}, argv: ['electron', '.'], packaged: false })).toBe(false)
  })
})
