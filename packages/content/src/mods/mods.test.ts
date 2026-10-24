import { rm } from 'node:fs/promises'
import path from 'node:path'
import { openZip } from '@amethyst/zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeZip, tempDir, zipBytes } from '../__fixtures__/build'
import { ContentError, parseLegacyDependencyString, parseManifest, readModMetadata, withPreferredLoader } from '../index'
import { parseLenientJson, repairJson } from '../util/json'

let tmp: string
beforeEach(async () => {
  tmp = await tempDir()
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const jar = (name: string, entries: Record<string, string | Uint8Array>) => makeZip(path.join(tmp, name), entries)

describe('lenient JSON', () => {
  it('accepts comments, trailing commas, raw newlines and single quotes', () => {
    const text = `﻿{
      // line comment
      "a": "one
two", /* block */
      'b': 'it\\'s "quoted"',
      "c": [1, 2, 3,],
      "url": "https://example.com/x", // not a comment inside a string
    }`
    const r = parseLenientJson(text)
    expect(r).toEqual({ ok: true, repaired: true, value: { a: 'one\ntwo', b: `it's "quoted"`, c: [1, 2, 3], url: 'https://example.com/x' } })
  })

  it('reports the strict error when repair does not help', () => {
    const r = parseLenientJson('{"a": }')
    expect(r.ok).toBe(false)
    expect(repairJson('{"x":1,}')).toBe('{"x":1}')
  })
})

describe('manifest', () => {
  it('parses continuation lines and stops at the first section', () => {
    const m = parseManifest('Manifest-Version: 1.0\r\nImplementation-Version: 1.2.3-very-long-vers\r\n ion-suffix\r\n\r\nName: x\r\nImplementation-Version: nope\r\n')
    expect(m['Implementation-Version']).toBe('1.2.3-very-long-version-suffix')
    expect(m.Name).toBeUndefined()
  })
})

describe('fabric.mod.json', () => {
  it('reads every field, including nested jars two levels deep', async () => {
    const inner2 = await zipBytes(tmp, { 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'deep-lib', version: '0.1' }) })
    const inner = await zipBytes(tmp, {
      'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'fabric-api-base', version: '0.4.0', jars: [{ file: 'META-INF/jars/deep.jar' }] }),
      'META-INF/jars/deep.jar': inner2,
    })
    const file = await jar('example.jar', {
      'fabric.mod.json': `{
        "schemaVersion": 1,
        "id": "examplemod",
        "version": "1.2.3+mc1.20.1",
        "name": "Example Mod",
        "description": "Does things",
        "authors": ["Alice", {"name": "Bob", "contact": {}}],
        "contributors": "Carol",
        "contact": {"homepage": "https://ex.com", "issues": "https://ex.com/issues", "sources": "https://git.ex.com"},
        "license": ["MIT", "Apache-2.0"],
        "icon": {"16": "assets/ex/16.png", "128": "assets/ex/128.png", "512": "assets/ex/512.png"},
        "environment": "client",
        "depends": {"fabricloader": ">=0.15", "minecraft": ["~1.20.1", "1.20.2"], "fabric-api": "*"},
        "recommends": {"modmenu": ">=7"},
        "breaks": {"optifabric": "*"},
        "provides": ["example_alias"],
        "jars": [{"file": "META-INF/jars/api.jar"}, {"file": "META-INF/jars/missing.jar"}],
      }`,
      'META-INF/jars/api.jar': inner,
    })
    const meta = await readModMetadata(file)
    expect(meta.loaders).toEqual(['fabric'])
    expect(meta).toMatchObject({
      primaryLoader: 'fabric',
      id: 'examplemod',
      name: 'Example Mod',
      version: '1.2.3+mc1.20.1',
      description: 'Does things',
      authors: ['Alice', 'Bob', 'Carol'],
      license: 'MIT, Apache-2.0',
      icon: 'assets/ex/128.png',
      environment: 'client',
      minecraftRange: '~1.20.1 || 1.20.2',
      loaderRange: '>=0.15',
      links: { homepage: 'https://ex.com', issues: 'https://ex.com/issues', sources: 'https://git.ex.com' },
    })
    expect(meta.dependencies).toEqual(
      expect.arrayContaining([
        { modId: 'fabricloader', range: '>=0.15', rangeKind: 'semver', required: true, kind: 'depends' },
        { modId: 'fabric-api', rangeKind: 'semver', required: true, kind: 'depends' },
        { modId: 'modmenu', range: '>=7', rangeKind: 'semver', required: false, kind: 'recommends' },
        { modId: 'optifabric', rangeKind: 'semver', required: false, kind: 'breaks' },
      ]),
    )
    expect(meta.provides).toEqual({ examplemod: '1.2.3+mc1.20.1', example_alias: '1.2.3+mc1.20.1', 'fabric-api-base': '0.4.0', 'deep-lib': '0.1' })
    expect(meta.byLoader.fabric?.nestedJars).toEqual(['META-INF/jars/api.jar', 'META-INF/jars/missing.jar'])
    expect(meta.warnings).toEqual([expect.objectContaining({ code: 'nested-jar', file: 'META-INF/jars/missing.jar' })])
  })

  it('normalises a single author string and picks the largest icon when none fit', async () => {
    const file = await jar('a.jar', { 'fabric.mod.json': JSON.stringify({ id: 'a', authors: 'Solo', icon: { 512: '/big.png' } }) })
    const meta = await readModMetadata(file)
    expect(meta).toMatchObject({ authors: ['Solo'], icon: 'big.png', environment: 'both' })
  })

  it('records Fabric API aliases', async () => {
    const file = await jar('fapi.jar', { 'fabric.mod.json': JSON.stringify({ id: 'fabric-api', version: '0.92.0' }) })
    expect((await readModMetadata(file)).provides).toMatchObject({ 'fabric-api': '0.92.0', fabric_api: '0.92.0', fabric: '0.92.0' })
  })

  it('returns a warning, not a throw, for malformed JSON and missing ids', async () => {
    const file = await jar('broken.jar', { 'fabric.mod.json': '{ "id": "x", ', 'quilt.mod.json': '{"quilt_loader": {}}' })
    const meta = await readModMetadata(file)
    expect(meta.loaders).toEqual([])
    expect(meta.id).toBeUndefined()
    expect(meta.warnings.map((w) => [w.file, w.code])).toEqual([
      ['fabric.mod.json', 'invalid-json'],
      ['quilt.mod.json', 'invalid-shape'],
    ])
  })
})

describe('quilt.mod.json', () => {
  it('reads dependencies, contributors, provides and environment', async () => {
    const file = await jar('q.jar', {
      'quilt.mod.json': JSON.stringify({
        schema_version: 1,
        quilt_loader: {
          group: 'org.example',
          id: 'example_mod',
          version: '1.0.0',
          provides: ['alias', { id: 'org.other:other', version: '2.0' }],
          metadata: {
            name: 'Example',
            description: 'Quilt mod',
            contributors: { Bob: 'Artist', Alice: 'Owner' },
            license: { name: 'MIT License', id: 'MIT', url: 'https://x' },
            icon: 'assets/example/icon.png',
          },
          depends: [
            'quilt_loader',
            { id: 'minecraft', versions: '>=1.20' },
            { id: 'org.quiltmc:qsl', versions: ['>=6', '<8'], optional: true },
            [{ id: 'sodium' }, { id: 'embeddium' }],
          ],
          breaks: [{ id: 'bad', versions: '*' }],
        },
        minecraft: { environment: 'dedicated_server' },
      }),
    })
    const meta = await readModMetadata(file)
    expect(meta).toMatchObject({
      loaders: ['quilt'],
      id: 'example_mod',
      name: 'Example',
      authors: ['Alice', 'Bob'],
      license: 'MIT License',
      environment: 'server',
      minecraftRange: '>=1.20',
      loaderRange: '*',
      provides: { example_mod: '1.0.0', alias: '1.0.0', other: '2.0' },
    })
    expect(meta.dependencies).toEqual([
      { modId: 'quilt_loader', rangeKind: 'semver', required: true, kind: 'depends' },
      { modId: 'minecraft', range: '>=1.20', rangeKind: 'semver', required: true, kind: 'depends' },
      { modId: 'qsl', range: '>=6 || <8', rangeKind: 'semver', required: false, kind: 'depends' },
      {
        modId: 'sodium',
        rangeKind: 'semver',
        required: true,
        kind: 'depends',
        alternatives: [{ modId: 'embeddium', rangeKind: 'semver', required: true, kind: 'depends' }],
      },
      { modId: 'bad', rangeKind: 'semver', required: false, kind: 'breaks' },
    ])
  })
})

const MODS_TOML = `
modLoader = "javafml"
loaderVersion = "[47,)"
license = "MIT"
issueTrackerURL = "https://issues"
authors = "Fallback Author"

[[mods]]
modId = "examplemod"
version = "\${file.jarVersion}"
displayName = "Example Mod"
description = '''
Multi-line
description'''
logoFile = "logo.png"
authors = "Alice, Bob"
displayURL = "https://home"
updateJSONURL = "https://update"
provides = ["example_alias"]

[[mods]]
modId = "examplecore"
version = "2.0"

[[dependencies.examplemod]]
modId = "forge"
mandatory = true
versionRange = "[47,)"
ordering = "NONE"
side = "BOTH"

[[dependencies.examplemod]]
modId = "minecraft"
type = "required"
versionRange = "[1.20.1,1.21)"
side = "BOTH"

[[dependencies.examplemod]]
modId = "jei"
type = "optional"
side = "CLIENT"

[[dependencies.examplemod]]
modId = "badmod"
type = "incompatible"
`

describe('mods.toml', () => {
  it('substitutes ${file.jarVersion} from the manifest and reads dependencies', async () => {
    const file = await jar('forge.jar', {
      'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nImplementation-Version: 3.4.5\n',
      'META-INF/mods.toml': MODS_TOML,
    })
    const meta = await readModMetadata(file)
    expect(meta).toMatchObject({
      loaders: ['forge'],
      id: 'examplemod',
      name: 'Example Mod',
      version: '3.4.5',
      description: 'Multi-line\ndescription',
      authors: ['Alice', 'Bob'],
      license: 'MIT',
      icon: 'logo.png',
      links: { homepage: 'https://home', issues: 'https://issues', update: 'https://update' },
      environment: 'both',
      minecraftRange: '[1.20.1,1.21)',
      loaderRange: '[47,)',
      provides: { examplemod: '3.4.5', example_alias: '3.4.5', examplecore: '2.0' },
      implementationVersion: '3.4.5',
    })
    expect(meta.dependencies).toEqual([
      { modId: 'forge', range: '[47,)', rangeKind: 'maven', side: 'both', required: true, kind: 'depends' },
      { modId: 'minecraft', range: '[1.20.1,1.21)', rangeKind: 'maven', side: 'both', required: true, kind: 'depends' },
      { modId: 'jei', rangeKind: 'maven', side: 'client', required: false, kind: 'depends' },
      { modId: 'badmod', rangeKind: 'maven', required: false, kind: 'breaks' },
    ])
  })

  it('shows ? when ${file.jarVersion} has no manifest version', async () => {
    const file = await jar('forge.jar', { 'META-INF/mods.toml': MODS_TOML })
    expect((await readModMetadata(file)).version).toBe('?')
  })

  it('warns instead of throwing on malformed TOML', async () => {
    const file = await jar('bad.jar', { 'META-INF/mods.toml': '[[mods]\nmodId = "x"' })
    const meta = await readModMetadata(file)
    expect(meta.loaders).toEqual([])
    expect(meta.warnings).toEqual([expect.objectContaining({ file: 'META-INF/mods.toml', code: 'invalid-toml' })])
  })

  it('reads neoforge.mods.toml as NeoForge and clientSideOnly', async () => {
    const file = await jar('neo.jar', {
      'META-INF/neoforge.mods.toml': `modLoader="javafml"\nloaderVersion="[2,)"\nlicense="LGPL"\nclientSideOnly=true\n[[mods]]\nmodId="neomod"\nversion="1.0"\n[[dependencies.neomod]]\nmodId="neoforge"\ntype="required"\nversionRange="[20.4,)"\n`,
    })
    const meta = await readModMetadata(file)
    expect(meta).toMatchObject({ loaders: ['neoforge'], id: 'neomod', environment: 'client', loaderRange: '[20.4,)' })
  })
})

describe('multi-loader jars', () => {
  it('keeps every loader and prefers per instance loader', async () => {
    const file = await jar('multi.jar', {
      'fabric.mod.json': JSON.stringify({ id: 'multi', name: 'Multi (Fabric)', version: '1.0+fabric' }),
      'META-INF/mods.toml': '[[mods]]\nmodId="multi"\ndisplayName="Multi (Forge)"\nversion="1.0+forge"\n',
      'META-INF/neoforge.mods.toml': '[[mods]]\nmodId="multi"\ndisplayName="Multi (NeoForge)"\nversion="1.0+neoforge"\n',
      'quilt.mod.json': JSON.stringify({ quilt_loader: { id: 'multi', version: '1.0+quilt', metadata: { name: 'Multi (Quilt)' } } }),
    })
    const vanilla = await readModMetadata(file)
    expect(vanilla.loaders).toEqual(['forge', 'fabric', 'quilt', 'neoforge'])
    expect(vanilla.name).toBe('Multi (Forge)')
    expect((await readModMetadata(file, { preferLoader: 'quilt' })).name).toBe('Multi (Quilt)')
    expect(withPreferredLoader(vanilla, 'neoforge')).toMatchObject({ primaryLoader: 'neoforge', version: '1.0+neoforge' })
    expect(withPreferredLoader(vanilla, 'fabric').loaders).toEqual(['fabric', 'quilt', 'forge', 'neoforge'])
  })

  it('accepts an open ZipReader and leaves it open', async () => {
    const file = await jar('z.jar', { 'fabric.mod.json': '{"id":"z"}' })
    const zip = await openZip(file)
    try {
      expect((await readModMetadata(zip)).id).toBe('z')
      expect(await zip.has('fabric.mod.json')).toBe(true)
    } finally {
      await zip.close()
    }
  })
})

describe('legacy formats', () => {
  it('reads mcmod.info (modList v2) with raw newlines', async () => {
    const file = await jar('old.jar', {
      'mcmod.info': `{"modListVersion": 2, "modList": [{
        "modid": "oldmod", "name": "Old Mod", "description": "Line one
line two", "version": "1.7.10-2.0", "mcversion": "1.7.10", "url": "https://old",
        "authorList": ["Dev"], "logoFile": "/logo.png", "requiredMods": ["Forge@[10.13,)", "CodeChickenCore"]
      }, {"modid": "oldmod_extra", "version": "1"}]}`,
    })
    const meta = await readModMetadata(file)
    expect(meta).toMatchObject({
      loaders: ['forge'],
      id: 'oldmod',
      description: 'Line one\nline two',
      authors: ['Dev'],
      icon: 'logo.png',
      minecraftRange: '1.7.10',
      provides: { oldmod: '1.7.10-2.0', oldmod_extra: '1' },
    })
    expect(meta.dependencies).toEqual([
      { modId: 'forge', range: '[10.13,)', rangeKind: 'maven', required: true, kind: 'depends' },
      { modId: 'CodeChickenCore', rangeKind: 'maven', required: true, kind: 'depends' },
    ])
  })

  it('reads a bare-array mcmod.info and tweaker manifests', async () => {
    const a = await jar('arr.jar', { 'mcmod.info': '[{"modid":"arr","name":"Arr","authors":["X"]}]' })
    expect(await readModMetadata(a)).toMatchObject({ id: 'arr', authors: ['X'] })
    const t = await jar('tweak.jar', {
      'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nTweakName: Tweaky\nTweakVersion: 0.9\nTweakAuthor: Someone\n',
    })
    expect(await readModMetadata(t)).toMatchObject({ loaders: ['forge'], id: 'Tweaky', version: '0.9', authors: ['Someone'] })
  })

  it('reads litemod.json', async () => {
    const file = await jar('x.litemod', { 'litemod.json': '{"name":"LiteThing","mcversion":"1.12.2","revision":"4","author":"L"}' })
    expect(await readModMetadata(file)).toMatchObject({ loaders: ['liteloader'], id: 'LiteThing', version: '1.12.2:4', authors: ['L'] })
  })

  it('parses @Mod dependency strings', () => {
    expect(parseLegacyDependencyString('required-after:Forge@[14.23,);after:jei;required-before:core')).toEqual([
      { modId: 'forge', range: '[14.23,)', rangeKind: 'maven', required: true, kind: 'depends' },
      { modId: 'core', rangeKind: 'maven', required: true, kind: 'depends' },
    ])
  })
})

describe('unknown and broken jars', () => {
  it('returns empty metadata for a jar without descriptors', async () => {
    const file = await jar('lib.jar', { 'com/example/Lib.class': 'cafebabe' })
    expect(await readModMetadata(file)).toMatchObject({ loaders: [], authors: [], dependencies: [], warnings: [] })
  })

  it('records Sinytra Connector as providing fabricloader', async () => {
    const file = await jar('connector.jar', {
      'META-INF/MANIFEST.MF': 'Automatic-Module-Name: org.sinytra.connector\nFabric-Loader-Version: 0.15.11\n',
      'META-INF/mods.toml': '[[mods]]\nmodId="connector"\nversion="1.0"\n',
    })
    expect((await readModMetadata(file)).provides).toEqual({ connector: '1.0', fabricloader: '0.15.11' })
  })

  it('throws EINVALID_ZIP for a corrupt archive and ENOT_FOUND for a missing one', async () => {
    const { writeFile } = await import('node:fs/promises')
    const bad = path.join(tmp, 'bad.jar')
    await writeFile(bad, 'this is not a zip')
    await expect(readModMetadata(bad)).rejects.toMatchObject({ name: 'ContentError', code: 'EINVALID_ZIP' })
    await expect(readModMetadata(path.join(tmp, 'nope.jar'))).rejects.toBeInstanceOf(ContentError)
    await expect(readModMetadata(path.join(tmp, 'nope.jar'))).rejects.toMatchObject({ code: 'ENOT_FOUND' })
  })
})
