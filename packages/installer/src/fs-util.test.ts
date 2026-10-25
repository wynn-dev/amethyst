import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempDir } from './__fixtures__/helpers'
import { writeFileAtomic } from './fs-util'

let root: string
beforeEach(async () => {
  root = await tempDir()
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('writeFileAtomic', () => {
  it('cleans up temp files left by crashed installs, keeping those of live processes', async () => {
    const dir = join(root, 'versions', '1.21.1')
    await mkdir(dir, { recursive: true })
    // 99999999 is above the macOS pid limit, so that process cannot be running.
    const dead = ['1.21.1.json.99999999-deadbeef.tmp', '.install-lock.99999999-0badf00d.tmp']
    const kept = [`1.21.1.json.${process.pid}-cafebabe.tmp`, '1.21.1.jar.1-abcdef12.tmp', 'notes.tmp', 'readme.txt']
    await Promise.all([...dead, ...kept].map((name) => writeFile(join(dir, name), 'partial')))

    await writeFileAtomic(join(dir, '1.21.1.json'), '{}')

    expect(await readFile(join(dir, '1.21.1.json'), 'utf8')).toBe('{}')
    expect((await readdir(dir)).toSorted()).toEqual(['1.21.1.json', ...kept].toSorted())
  })
})
