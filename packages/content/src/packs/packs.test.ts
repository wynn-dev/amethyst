import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeZip, tempDir, writeTree } from '../__fixtures__/build'
import { flattenTextComponent, parsePackMcmeta, readPackFile, readResourcePack, readShaderPack, stripFormatting } from '../index'

let tmp: string
beforeEach(async () => {
  tmp = await tempDir()
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('text components', () => {
  it('keeps plain strings and legacy § codes', () => {
    expect(flattenTextComponent('§6Gold §rpack')).toBe('§6Gold §rpack')
    expect(flattenTextComponent(42)).toBe('42')
  })

  it('flattens objects with styles inherited by extra', () => {
    const c = { text: 'Hello ', color: 'gold', bold: true, extra: [{ text: 'World', color: 'aqua', bold: false }, '!'] }
    expect(flattenTextComponent(c)).toBe('§6§lHello §r§bWorld§r§6§l!')
  })

  it('treats the first array element as the parent', () => {
    expect(flattenTextComponent([{ text: 'A', color: 'red' }, ' B', { text: ' C', italic: true }])).toBe('§cA B§r§c§o C')
    expect(flattenTextComponent(['', { text: 'x', color: 'green' }, 'y'])).toBe('§ax§ry')
  })

  it('maps hex colours to the nearest legacy colour and handles translate', () => {
    expect(flattenTextComponent({ text: 'hex', color: '#FF5050' })).toBe('§chex')
    expect(flattenTextComponent({ translate: 'pack.desc', fallback: 'By %s and %s', with: ['Ann', { text: 'Ben', color: 'red' }] })).toBe('By Ann and Ben')
    expect(flattenTextComponent({ translate: 'some.key' })).toBe('some.key')
  })

  it('strips formatting', () => {
    expect(stripFormatting('§6§lHello §r§bWorld§')).toBe('Hello World')
  })
})

describe('pack.mcmeta', () => {
  it('parses all supported_formats shapes', () => {
    expect(parsePackMcmeta('{"pack":{"pack_format":15,"description":"x"}}').formats).toEqual({ min: { major: 15, minor: 0 }, max: { major: 15, minor: 0 } })
    expect(parsePackMcmeta('{"pack":{"pack_format":18,"supported_formats":[16,20],"description":""}}').formats).toEqual({
      min: { major: 16, minor: 0 },
      max: { major: 20, minor: 0 },
    })
    expect(parsePackMcmeta('{"pack":{"pack_format":18,"supported_formats":{"min_inclusive":17,"max_inclusive":34}}}').formats).toEqual({
      min: { major: 17, minor: 0 },
      max: { major: 34, minor: 0 },
    })
    expect(parsePackMcmeta('{"pack":{"min_format":[69,0],"max_format":[69,1],"description":"new"}}')).toMatchObject({
      valid: true,
      formats: { min: { major: 69, minor: 0 }, max: { major: 69, minor: 1 } },
    })
  })

  it('accepts raw newlines (lenient) and reports unusable files', () => {
    expect(parsePackMcmeta('{"pack":{"pack_format":1,"description":"two\nlines"}}')).toMatchObject({ valid: true, description: 'two\nlines', packFormat: 1 })
    expect(parsePackMcmeta('{"pack":')).toMatchObject({ valid: false, warnings: [expect.objectContaining({ code: 'invalid-mcmeta' })] })
    expect(parsePackMcmeta('{"other":{}}')).toMatchObject({ valid: false })
  })
})

describe('resource packs', () => {
  const mcmeta = JSON.stringify({ pack: { pack_format: 34, description: [{ text: 'Faithful', color: 'gold' }, { text: ' 32x', color: 'gray' }] } })

  it('reads a zip pack with a text-component description and icon', async () => {
    const file = await makeZip(path.join(tmp, 'Faithful.zip'), { 'pack.mcmeta': mcmeta, 'pack.png': PNG, 'assets/minecraft/x.png': PNG })
    const info = await readResourcePack(file)
    expect(info).toMatchObject({
      format: 'zip',
      valid: true,
      packFormat: 34,
      description: '§6Faithful§r§7 32x',
      descriptionPlain: 'Faithful 32x',
      icon: 'pack.png',
      warnings: [],
    })
    expect(await readPackFile(file, 'pack.png')).toEqual(PNG)
  })

  it('reads a folder pack', async () => {
    const dir = path.join(tmp, 'Folder Pack')
    await writeTree(dir, { 'pack.mcmeta': mcmeta })
    expect(await readResourcePack(dir)).toMatchObject({ format: 'folder', valid: true, descriptionPlain: 'Faithful 32x' })
    expect((await readResourcePack(dir)).icon).toBeUndefined()
  })

  it('flags packs nested one level too deep and packs without pack.mcmeta', async () => {
    const nested = await makeZip(path.join(tmp, 'nested.zip'), { 'Inner/pack.mcmeta': mcmeta, 'Inner/pack.png': PNG, '__MACOSX/._Inner': 'x' })
    expect(await readResourcePack(nested)).toMatchObject({ valid: false, nestedRoot: 'Inner', warnings: [expect.objectContaining({ code: 'nested-too-deep' })] })
    const junk = await makeZip(path.join(tmp, 'junk.zip'), { 'readme.md': 'hi' })
    expect(await readResourcePack(junk)).toMatchObject({ valid: false, warnings: [expect.objectContaining({ code: 'missing-mcmeta' })] })
  })

  it('throws a ContentError for a corrupt zip', async () => {
    const bad = path.join(tmp, 'bad.zip')
    await writeFile(bad, 'nope')
    await expect(readResourcePack(bad)).rejects.toMatchObject({ code: 'EINVALID_ZIP' })
  })
})

describe('shader packs', () => {
  it('detects shaders/ without requiring shaders.properties', async () => {
    const file = await makeZip(path.join(tmp, 'BSL.zip'), { 'shaders/composite.fsh': 'void main(){}', 'shaders/lang/en_US.lang': 'a=b' })
    expect(await readShaderPack(file)).toEqual({ format: 'zip', valid: true, hasProperties: false, languages: ['en_US.lang'], warnings: [] })
  })

  it('reads folder packs and flags nesting and junk', async () => {
    const dir = path.join(tmp, 'Complementary')
    await writeTree(dir, { 'shaders/shaders.properties': 'x=1', 'shaders/lang/en_US.lang': '' })
    expect(await readShaderPack(dir)).toMatchObject({ format: 'folder', valid: true, hasProperties: true, languages: ['en_US.lang'] })
    const nested = await makeZip(path.join(tmp, 'n.zip'), { 'Pack v1/shaders/final.fsh': '' })
    expect(await readShaderPack(nested)).toMatchObject({ valid: false, nestedRoot: 'Pack v1', warnings: [expect.objectContaining({ code: 'nested-too-deep' })] })
    const junk = await makeZip(path.join(tmp, 'j.zip'), { 'x.txt': '' })
    expect(await readShaderPack(junk)).toMatchObject({ valid: false, warnings: [expect.objectContaining({ code: 'missing-shaders' })] })
  })
})
