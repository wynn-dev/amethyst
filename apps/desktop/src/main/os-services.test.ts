import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shell = vi.hoisted(() => ({
  openPath: vi.fn<(p: string) => Promise<string>>(async () => ''),
  showItemInFolder: vi.fn<(p: string) => void>(),
  openExternal: vi.fn<(u: string) => Promise<void>>(async () => {}),
}))
vi.mock('electron', () => ({ shell, app: {}, BrowserWindow: {}, dialog: {}, nativeTheme: {} }))
vi.mock('./rpc/server', () => ({ callingWebContents: () => undefined }))
vi.mock('./runtime', () => ({ showHiddenWindows: () => {} }))

const { isPackageDirectory, shellService } = await import('./os-services')

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'amethyst-shell-')))
  shell.openPath.mockClear()
  shell.showItemInFolder.mockClear()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('shell.openFolder', () => {
  it('opens plain folders, but only reveals apps and other bundles (never launches them)', async () => {
    const plain = path.join(root, '1.20.1 Fabric')
    const app = path.join(root, 'Evil.app')
    const disguised = path.join(root, 'Notes.thing')
    await mkdir(plain)
    await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true })
    await mkdir(path.join(disguised, 'Contents'), { recursive: true })
    await writeFile(path.join(disguised, 'Contents', 'Info.plist'), '<plist/>')
    await symlink(app, path.join(root, 'innocent folder'))

    await shellService.openFolder(plain)
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(plain)

    // oxlint-disable-next-line no-await-in-loop -- the calls are checked in order
    for (const p of [app, `${app}/`, disguised, path.join(root, 'innocent folder')]) await shellService.openFolder(p)
    expect(shell.openPath).toHaveBeenCalledTimes(1)
    expect(shell.showItemInFolder.mock.calls.map(([p]) => p)).toEqual([app, app, disguised, app])

    expect(await isPackageDirectory(plain)).toBe(false)
    expect(await isPackageDirectory(path.join(root, 'Some.Pack'))).toBe(false)
    expect(await isPackageDirectory(path.join(root, 'Installer.PKG'))).toBe(true)
    await expect(shellService.openFolder(path.join(root, 'gone'))).rejects.toMatchObject({ code: 'ENOT_FOUND' })
    await expect(shellService.openFolder('relative/path')).rejects.toMatchObject({ code: 'EINVALID_ARGUMENT' })
  })
})
