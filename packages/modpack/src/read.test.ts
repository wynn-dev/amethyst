import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeCfZip, makeMrpack, makeZip, mrFile, patchZipNames, sha, tempDir } from './__fixtures__/build'
import { checkPackPath, deriveName, parseCurseForgeLoaderId, readModpack } from './index'

let tmp: string
beforeEach(async () => {
  tmp = await tempDir()
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('format detection', () => {
  it('reads a root mrpack with overrides, client-overrides precedence and env', async () => {
    const file = await makeMrpack(
      path.join(tmp, 'pack.mrpack'),
      {
        name: 'Example',
        summary: 'Short',
        files: [mrFile('mods/a.jar', 'A', { env: { client: 'required', server: 'unsupported' } }), mrFile('mods/b.jar', 'B')],
      },
      {
        'overrides/config/a.toml': 'override',
        'overrides/options.txt': 'base',
        'client-overrides/options.txt': 'client',
        'overrides-extra/ignored.txt': 'nope',
        'server-overrides/server.properties': 'x',
        '__MACOSX/overrides/._a': 'junk',
        'overrides/.DS_Store': 'junk',
      },
    )
    const m = await readModpack(file)
    expect(m.format).toBe('modrinth')
    expect(m.prefix).toBe('')
    expect(m.name).toBe('Example')
    expect(m.summary).toBe('Short')
    expect(m.version).toBe('1.0.0')
    expect(m.minecraft).toBe('1.20.1')
    expect(m.loader).toEqual({ id: 'fabric', version: '0.15.11' })
    expect(m.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(m.files).toHaveLength(2)
    expect(m.files[0]).toMatchObject({ kind: 'modrinth', path: 'mods/a.jar', env: { client: 'required', server: 'unsupported' }, size: 1 })
    expect(m.files[1]).toMatchObject({ env: { client: 'required', server: 'required' } })
    const overrides = Object.fromEntries(m.overrides.map((o) => [o.path, o.layer]))
    expect(overrides).toEqual({ 'config/a.toml': 'overrides', 'options.txt': 'client-overrides' })
    expect(m.overridesDirs).toEqual(['overrides/', 'client-overrides/'])
  })

  it('detects a zipped folder (one top-level folder holding modrinth.index.json)', async () => {
    const file = await makeMrpack(path.join(tmp, 'nested.zip'), { files: [mrFile('mods/a.jar', 'A')] }, { 'overrides/x.txt': 'x' }, 'My Pack/')
    const m = await readModpack(file)
    expect(m.prefix).toBe('My Pack/')
    expect(m.overrides).toMatchObject([{ path: 'x.txt', entry: 'My Pack/overrides/x.txt' }])
  })

  it('reads a CurseForge zip with a BOM and a custom overrides folder', async () => {
    const file = await makeCfZip(
      path.join(tmp, 'cf.zip'),
      { overrides: 'extra', files: [{ projectID: 1, fileID: 10, required: true }, { projectID: 2, fileID: 20, required: false }] },
      { 'extra/config/b.cfg': 'b', 'overrides/not-used.txt': 'n', 'modlist.html': '<ul></ul>' },
      true,
    )
    const m = await readModpack(file)
    expect(m.format).toBe('curseforge')
    expect(m.name).toBe('CF Pack')
    expect(m.author).toBe('someone')
    expect(m.version).toBe('2.0.0')
    expect(m.loader).toEqual({ id: 'forge', version: '47.2.0' })
    expect(m.files).toEqual([
      { kind: 'curseforge', projectId: 1, fileId: 10, required: true },
      { kind: 'curseforge', projectId: 2, fileId: 20, required: false },
    ])
    expect(m.overridesDirs).toEqual(['extra/'])
    expect(m.overrides.map((o) => o.path)).toEqual(['config/b.cfg'])
  })

  it('reports friendly errors for non-packs', async () => {
    await expect(readModpack(path.join(tmp, 'missing.mrpack'))).rejects.toMatchObject({ code: 'ENOT_A_FILE' })
    await expect(readModpack(tmp)).rejects.toMatchObject({ code: 'ENOT_A_FILE' })
    const rar = path.join(tmp, 'pack.rar')
    await writeFile(rar, 'Rar!\u001a\u0007\u0000 not a zip')
    await expect(readModpack(rar)).rejects.toMatchObject({ code: 'ENOT_A_ZIP' })
    const jar = await makeZip(path.join(tmp, 'mod.jar'), { 'fabric.mod.json': '{}' })
    await expect(readModpack(jar)).rejects.toMatchObject({ code: 'EUNKNOWN_FORMAT' })
    const notCf = await makeZip(path.join(tmp, 'other.zip'), { 'manifest.json': '{"manifestType":"other"}' })
    await expect(readModpack(notCf)).rejects.toMatchObject({ code: 'EUNKNOWN_FORMAT' })
  })

  it('validates the manifest and names the bad field', async () => {
    const v2 = await makeMrpack(path.join(tmp, 'v2.mrpack'), { formatVersion: 2 })
    await expect(readModpack(v2)).rejects.toMatchObject({ code: 'EUNSUPPORTED_FORMAT' })
    const game = await makeMrpack(path.join(tmp, 'game.mrpack'), { game: 'terraria' })
    await expect(readModpack(game)).rejects.toMatchObject({ code: 'EUNSUPPORTED_FORMAT' })
    const badHash = await makeMrpack(path.join(tmp, 'hash.mrpack'), { files: [{ ...mrFile('mods/a.jar', 'A'), hashes: { sha1: 'xyz' } }] })
    await expect(readModpack(badHash)).rejects.toMatchObject({ code: 'EINVALID_MANIFEST', field: 'files[0].hashes.sha1' })
    const badJson = await makeZip(path.join(tmp, 'json.mrpack'), { 'modrinth.index.json': '{oops' })
    await expect(readModpack(badJson)).rejects.toMatchObject({ code: 'EINVALID_MANIFEST' })
    const noLoaders = await makeCfZip(path.join(tmp, 'noloaders.zip'), { minecraft: { version: '1.20.1' } })
    await expect(readModpack(noLoaders)).rejects.toMatchObject({ code: 'EINVALID_MANIFEST', field: 'minecraft.modLoaders' })
    const badId = await makeCfZip(path.join(tmp, 'badid.zip'), { files: [{ projectID: -1, fileID: 3 }] })
    await expect(readModpack(badId)).rejects.toMatchObject({ code: 'EINVALID_MANIFEST', field: 'files[0].projectID' })
    const twoLoaders = await makeMrpack(path.join(tmp, 'two.mrpack'), { dependencies: { minecraft: '1.20.1', forge: '47.2.0', 'fabric-loader': '0.15.0' } })
    await expect(readModpack(twoLoaders)).rejects.toMatchObject({ code: 'EINVALID_MANIFEST', field: 'dependencies.fabric-loader' })
  })

  it('derives a name when the pack has none, and warns about unknown dependencies', async () => {
    const file = await makeMrpack(path.join(tmp, 'all-the-mods_9-0.2.44.mrpack'), { name: '', dependencies: { minecraft: '1.20.1', foo: '1' } })
    const m = await readModpack(file)
    expect(m.name).toBe('All The Mods 9')
    expect(m.loader).toBeNull()
    expect(m.warnings.map((w) => w.code).toSorted()).toEqual(['derived-name', 'unknown-dependency'])
    expect(deriveName('Cool_Pack-v1.2.3.zip')).toBe('Cool Pack')
  })
})

describe('path safety', () => {
  it('drops traversal, absolute, backslash and launcher-owned paths but keeps the rest of the pack', async () => {
    const file = await makeMrpack(
      path.join(tmp, 'evil.mrpack'),
      {
        files: [
          mrFile('../escape.jar', 'x'),
          mrFile('/etc/passwd', 'x'),
          mrFile('mods\\win.jar', 'x'),
          mrFile('mods/../../up.jar', 'x'),
          mrFile('versions/1.20.1/1.20.1.json', 'x'),
          mrFile('.amethyst/lock.json', 'x'),
          { ...mrFile('mods/http.jar', 'x'), downloads: ['http://example.com/a.jar', 'file:///etc/passwd'] },
          mrFile('mods/ok.jar', 'ok'),
        ],
      },
      {
        'overrides/@@/@@/zip-slip.txt': 'x',
        'overrides/libraries/evil.jar': 'x',
        'overrides/config/fine.txt': 'fine',
      },
    )
    await patchZipNames(file, '@@/@@', '../..')
    const m = await readModpack(file)
    expect(m.files.map((f) => (f.kind === 'modrinth' ? f.path : ''))).toEqual(['mods/ok.jar'])
    expect(m.overrides.map((o) => o.path)).toEqual(['config/fine.txt'])
    const unsafe = m.warnings.filter((w) => w.code === 'unsafe-path')
    expect(unsafe).toHaveLength(8)
    expect(m.warnings.some((w) => w.code === 'insecure-url' && w.subject === 'mods/http.jar')).toBe(true)
  })

  it('rejects an unsafe CurseForge overrides folder', async () => {
    const file = await makeCfZip(path.join(tmp, 'cf.zip'), { overrides: '../outside' })
    await expect(readModpack(file)).rejects.toMatchObject({ code: 'EINVALID_MANIFEST', field: 'overrides' })
  })

  it('checks paths', () => {
    expect(checkPackPath('mods/./a.jar')).toEqual({ ok: true, path: 'mods/a.jar' })
    expect(checkPackPath('C:evil')).toMatchObject({ ok: false })
    expect(checkPackPath('a\u0000b')).toMatchObject({ ok: false })
    expect(checkPackPath('Assets/x')).toMatchObject({ ok: false })
    expect(checkPackPath('')).toMatchObject({ ok: false })
  })
})

describe('loader mapping', () => {
  it.each([
    ['forge', '47.2.0', { id: 'forge', version: '47.2.0' }],
    ['neoforge', '20.4.237', { id: 'neoforge', version: '20.4.237' }],
    ['fabric-loader', '0.15.11', { id: 'fabric', version: '0.15.11' }],
    ['quilt-loader', '0.26.0', { id: 'quilt', version: '0.26.0' }],
  ])('maps Modrinth %s', async (key, version, expected) => {
    const file = await makeMrpack(path.join(tmp, `${key}.mrpack`), { dependencies: { minecraft: '1.20.4', [key]: version } })
    expect((await readModpack(file)).loader).toEqual(expected)
  })

  it.each([
    ['forge-47.2.0', { id: 'forge', version: '47.2.0' }],
    ['neoforge-1.20.1-47.1.84', { id: 'neoforge', version: '47.1.84' }],
    ['neoforge-20.4.237', { id: 'neoforge', version: '20.4.237' }],
    ['fabric-0.15.11', { id: 'fabric', version: '0.15.11' }],
    ['quilt-0.26.0', { id: 'quilt', version: '0.26.0' }],
  ])('maps CurseForge %s', async (id, expected) => {
    const file = await makeCfZip(path.join(tmp, `${id}.zip`), {
      minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-1.0', primary: false }, { id, primary: true }] },
    })
    expect((await readModpack(file)).loader).toEqual(expected)
  })

  it('uses the first loader without a primary, strips Minecraft affixes and rejects unknown ids', async () => {
    expect(parseCurseForgeLoaderId('forge-1.7.10-10.13.4.1614-1.7.10', '1.7.10')).toEqual({ id: 'forge', version: '10.13.4.1614' })
    expect(parseCurseForgeLoaderId('optifine-HD_U', '1.20.1')).toBeUndefined()
    const first = await makeCfZip(path.join(tmp, 'first.zip'), { minecraft: { version: '1.20.1', modLoaders: [{ id: 'fabric-0.14.0' }, { id: 'forge-1' }] } })
    expect((await readModpack(first)).loader).toEqual({ id: 'fabric', version: '0.14.0' })
    const unknown = await makeCfZip(path.join(tmp, 'unknown.zip'), { minecraft: { version: '1.20.1', modLoaders: [{ id: 'rift-1.0', primary: true }] } })
    await expect(readModpack(unknown)).rejects.toMatchObject({ code: 'EINVALID_MANIFEST', field: 'minecraft.modLoaders[0].id' })
    expect(sha('sha1', '')).toHaveLength(40)
  })
})
