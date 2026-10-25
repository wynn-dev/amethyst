import { describe, expect, it, vi } from 'vitest'
import type { InstancePatch } from '@shared/services'
import { changeVersion, targetRuntime, type ChangeVersionDeps } from './change-version'

function deps(overrides: Partial<{ running: boolean; installing: boolean; modpack: boolean }> = {}) {
  const calls: string[] = []
  const d: ChangeVersionDeps = {
    instances: {
      resolve: (id) => {
        calls.push(`resolve ${id}`)
        return {} as ReturnType<ChangeVersionDeps['instances']['resolve']>
      },
      update: async (id: string, patch: InstancePatch) => {
        calls.push(`update ${id} ${JSON.stringify(patch.runtime)}`)
        return {} as Awaited<ReturnType<ChangeVersionDeps['instances']['update']>>
      },
    },
    install: {
      isBusy: () => overrides.installing ?? false,
      install: async (id) => {
        calls.push(`install ${id}`)
        return { versionId: 'fabric-loader-0.16.5-1.21.1', durationMs: 5, bytes: 10 }
      },
    },
    isRunning: () => overrides.running ?? false,
    isModpackBusy: () => overrides.modpack ?? false,
    changing: new Set(),
    backupWorlds: async (id) => {
      calls.push(`backup ${id}`)
      return 2
    },
  }
  return { d, calls }
}

describe('changeVersion', () => {
  it('backs up, switches the runtime (clearing other loaders), then installs', async () => {
    const { d, calls } = deps()
    const out = await changeVersion(d, 'i1', { minecraft: '1.21.1', fabric: '0.16.5' })
    expect(out).toEqual({ versionId: 'fabric-loader-0.16.5-1.21.1', durationMs: 5, bytes: 10, backedUpWorlds: 2 })
    expect(calls).toEqual(['resolve i1', 'backup i1', 'update i1 {"minecraft":"1.21.1","forge":"","neoforge":"","fabric":"0.16.5","quilt":""}', 'install i1'])
  })

  it('refuses while the game runs or installs, before touching anything', async () => {
    for (const o of [{ running: true }, { installing: true }, { modpack: true }]) {
      const { d, calls } = deps(o)
      await expect(changeVersion(d, 'i1', { minecraft: '1.20.1' })).rejects.toMatchObject({ code: 'EBUSY' })
      expect(calls).toEqual(['resolve i1'])
    }
  })

  it('holds the instance busy across the slow world backup, so a launch cannot start in that window', async () => {
    const { d, calls } = deps()
    let finishBackup!: () => void
    d.backupWorlds = async (id) => {
      calls.push(`backup ${id}`)
      await new Promise<void>((r) => (finishBackup = r))
      return 1
    }
    const running = changeVersion(d, 'i1', { minecraft: '1.21.1' })
    await vi.waitFor(() => expect(calls).toContain('backup i1'))
    // What launch (and a second change) checks while the backup runs.
    expect(d.changing?.has('i1')).toBe(true)
    await expect(changeVersion(d, 'i1', { minecraft: '1.20.1' })).rejects.toMatchObject({ code: 'EBUSY' })
    finishBackup()
    await running
    expect(d.changing?.has('i1')).toBe(false)
  })

  it('stops before switching when the game was started during the backup anyway', async () => {
    const { d, calls } = deps()
    let running = false
    d.isRunning = () => running
    d.backupWorlds = async () => {
      running = true
      return 1
    }
    await expect(changeVersion(d, 'i1', { minecraft: '1.21.1' })).rejects.toMatchObject({ code: 'EBUSY' })
    expect(calls.some((c) => c.startsWith('update') || c.startsWith('install'))).toBe(false)
    expect(d.changing?.has('i1')).toBe(false)
  })

  it('validates the runtime', () => {
    expect(() => targetRuntime({ minecraft: '' })).toThrow(expect.objectContaining({ code: 'EINVALID_ARGUMENT' }))
    expect(() => targetRuntime({ minecraft: '1.20.1', forge: '47.3.0', fabric: '0.16.5' })).toThrow(expect.objectContaining({ code: 'EINVALID_ARGUMENT' }))
    expect(targetRuntime({ minecraft: ' 1.20.1 ', forge: '47.3.0' })).toEqual({ minecraft: '1.20.1', forge: '47.3.0', neoforge: '', fabric: '', quilt: '' })
  })
})
