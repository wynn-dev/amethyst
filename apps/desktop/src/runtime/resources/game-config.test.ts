import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getProperty, readActiveShaderPack, setProperties, writeActiveShaderPack } from './game-config'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'amethyst-gamecfg-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('.properties handling', () => {
  it('splits on the first = only, so values containing = survive', () => {
    const text = '# comment\nshaderPack=a=b==c.zip\nother=x=y\n'
    expect(getProperty(text, 'shaderPack')).toBe('a=b==c.zip')
    const out = setProperties(text, { enableShaders: 'true' })
    expect(out).toBe('# comment\nshaderPack=a=b==c.zip\nother=x=y\nenableShaders=true\n')
    expect(getProperty(setProperties(text, { shaderPack: 'k=v.zip' }), 'shaderPack')).toBe('k=v.zip')
  })

  it('writes only the detected shader mod config and round-trips non-ASCII names', async () => {
    await writeActiveShaderPack(dir, 'iris', 'Café = 😀.zip')
    expect(await readdir(dir)).toEqual(['config'])
    expect(await readdir(path.join(dir, 'config'))).toEqual(['iris.properties'])
    expect(await readFile(path.join(dir, 'config', 'iris.properties'), 'utf8')).toMatch(/^shaderPack=Caf\\u00e9 = \\ud83d\\ude00\.zip\nenableShaders=true\n$/)
    expect(await readActiveShaderPack(dir)).toBe('Café = 😀.zip')
  })
})
