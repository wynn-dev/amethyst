import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeZip, tempDir } from './__fixtures__/build'
import {
  disableResourcePack,
  enableResourcePack,
  GameOptions,
  isFilePackId,
  orderResourcePacks,
  packNameFromId,
  parsePackList,
  readOptionsFile,
  resourcePackId,
  scanContentFolder,
  writeOptionsFile,
} from './index'

let tmp: string
beforeEach(async () => {
  tmp = await tempDir()
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const SAMPLE = [
  'version:3955',
  'autoJump:false',
  'key_key.attack:key.mouse.left',
  'lastServer:play.example.com:25565',
  'resourcePacks:["vanilla","fabric","file/Faithful.zip"]',
  'incompatibleResourcePacks:[]',
  'some garbage line',
  'modded_key:1',
  '',
].join('\n')

describe('GameOptions', () => {
  it('round-trips byte for byte', () => {
    expect(GameOptions.parse(SAMPLE).toString()).toBe(SAMPLE)
    const crlf = SAMPLE.replaceAll('\n', '\r\n')
    expect(GameOptions.parse(crlf).toString()).toBe(crlf)
    expect(GameOptions.parse('a:1').toString()).toBe('a:1')
  })

  it('splits on the first colon and preserves order', () => {
    const o = GameOptions.parse(SAMPLE)
    expect(o.get('lastServer')).toBe('play.example.com:25565')
    expect(o.get('key_key.attack')).toBe('key.mouse.left')
    expect(o.keys()).toEqual(['version', 'autoJump', 'key_key.attack', 'lastServer', 'resourcePacks', 'incompatibleResourcePacks', 'modded_key'])
  })

  it('edits in place and appends new keys', () => {
    const o = GameOptions.parse(SAMPLE)
    o.set('autoJump', true).set('fov', 0.5)
    o.delete('modded_key')
    expect(o.toString()).toBe(SAMPLE.replace('autoJump:false', 'autoJump:true').replace('modded_key:1\n', 'fov:0.5\n'))
    expect(() => o.set('bad\nkey', 1)).toThrow(RangeError)
  })

  it('reads and writes resource pack lists', () => {
    const o = GameOptions.parse(SAMPLE)
    expect(o.resourcePacks).toEqual(['vanilla', 'fabric', 'file/Faithful.zip'])
    o.resourcePacks = enableResourcePack(o.resourcePacks, 'file/My Folder Pack')
    expect(o.get('resourcePacks')).toBe('["vanilla","fabric","file/Faithful.zip","file/My Folder Pack"]')
    o.incompatibleResourcePacks = ['file/Old.zip']
    expect(o.incompatibleResourcePacks).toEqual(['file/Old.zip'])
  })
})

describe('pack list helpers', () => {
  it('salvages truncated or garbled values', () => {
    expect(parsePackList('["vanilla","file/A.zip","file/B')).toEqual(['vanilla', 'file/A.zip'])
    expect(parsePackList('[vanilla')).toEqual([])
    expect(parsePackList(undefined)).toEqual([])
    expect(parsePackList('["a\\"b"]')).toEqual(['a"b'])
  })

  it('builds ids for zips and folders without adding an extension', () => {
    expect(resourcePackId('Faithful.zip')).toBe('file/Faithful.zip')
    expect(resourcePackId('My Folder Pack')).toBe('file/My Folder Pack')
    expect(packNameFromId('file/My Folder Pack')).toBe('My Folder Pack')
    expect(isFilePackId('fabric')).toBe(false)
  })

  it('enables at the top, disables and reorders without touching built-in packs', () => {
    expect(enableResourcePack([], 'file/A.zip')).toEqual(['vanilla', 'file/A.zip'])
    expect(enableResourcePack(['vanilla', 'file/A.zip', 'file/B.zip'], 'file/A.zip')).toEqual(['vanilla', 'file/B.zip', 'file/A.zip'])
    expect(disableResourcePack(['vanilla', 'fabric', 'file/A.zip'], 'file/A.zip')).toEqual(['vanilla', 'fabric'])
    expect(orderResourcePacks(['vanilla', 'file/A.zip', 'fabric', 'file/B.zip'], ['file/A.zip', 'file/B.zip'])).toEqual(['vanilla', 'fabric', 'file/B.zip', 'file/A.zip'])
  })

  it('matches folder packs found by a scan to their options.txt entry', async () => {
    const instance = path.join(tmp, 'instance')
    const rp = path.join(instance, 'resourcepacks')
    await mkdir(path.join(rp, 'My Folder Pack'), { recursive: true })
    await writeFile(path.join(rp, 'My Folder Pack', 'pack.mcmeta'), '{"pack":{"pack_format":34,"description":"folder"}}')
    await makeZip(path.join(rp, 'Zipped.zip'), { 'pack.mcmeta': '{"pack":{"pack_format":34,"description":"zip"}}' })
    const options = GameOptions.parse('resourcePacks:["vanilla","file/My Folder Pack"]\n')
    const scan = await scanContentFolder(rp, 'resourcepacks', { enabledPacks: options.resourcePacks })
    expect(scan.entries.map((e) => [e.packId, e.enabled])).toEqual([
      ['file/My Folder Pack', true],
      ['file/Zipped.zip', false],
    ])
  })
})

describe('options files', () => {
  it('reads a missing file as empty and writes atomically', async () => {
    const file = path.join(tmp, 'options.txt')
    const empty = await readOptionsFile(file)
    expect(empty.keys()).toEqual([])
    empty.set('lang', 'en_us')
    await writeOptionsFile(file, empty)
    expect(await readFile(file, 'utf8')).toBe('lang:en_us\n')
    const again = await readOptionsFile(file)
    again.resourcePacks = ['vanilla']
    await writeOptionsFile(file, again)
    expect(await readFile(file, 'utf8')).toBe('lang:en_us\nresourcePacks:["vanilla"]\n')
  })
})
