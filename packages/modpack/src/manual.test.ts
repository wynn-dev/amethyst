import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha, tempDir } from './__fixtures__/build'
import { matchManualFiles, watchForManualFiles, type ManualDownload, type ManualFileMatch } from './index'

let tmp: string
let downloads: string
beforeEach(async () => {
  tmp = await tempDir()
  downloads = path.join(tmp, 'Downloads')
  await mkdir(downloads)
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const expected = (fileName: string, data: string, fileId: number): ManualDownload => ({
  name: `Project ${fileId}`,
  fileName,
  websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/p/download/${fileId}`,
  sha1: sha('sha1', data),
  size: Buffer.byteLength(data),
  path: `mods/${fileName}`,
  projectId: fileId * 10,
  fileId,
})

/** Collect matches until the watcher ends, or fail after `ms`. */
async function collect(iterable: AsyncIterable<ManualFileMatch>, ms = 5000): Promise<ManualFileMatch[]> {
  const out: ManualFileMatch[] = []
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('watcher timed out')), ms).unref())
  await Promise.race([
    (async () => {
      for await (const m of iterable) out.push(m)
    })(),
    timeout,
  ])
  return out
}

describe('matchManualFiles', () => {
  it('matches by hash and size, whatever the file name', async () => {
    const a = expected('a.jar', 'alpha', 1)
    const b = { ...expected('b.jar', 'beta', 2), sha1: undefined, md5: sha('md5', 'beta') }
    await writeFile(path.join(tmp, 'renamed.jar'), 'alpha')
    await writeFile(path.join(tmp, 'b.jar'), 'beta')
    await writeFile(path.join(tmp, 'a.jar'), 'wrong')
    const { matched, rejected } = await matchManualFiles([path.join(tmp, 'a.jar'), path.join(tmp, 'renamed.jar'), path.join(tmp, 'b.jar'), path.join(tmp, 'nope.jar')], [a, b])
    expect(matched.map((m) => [path.basename(m.file), m.expected.fileId])).toEqual([
      ['renamed.jar', 1],
      ['b.jar', 2],
    ])
    expect(rejected.map((r) => path.basename(r.file))).toEqual(['a.jar', 'nope.jar'])
  })
})

describe('watchForManualFiles', () => {
  it('reports new matching files, ignores impostors and partial downloads, and ends when all matched', async () => {
    await writeFile(path.join(downloads, 'old.jar'), 'gamma')
    const want = [expected('first.jar', 'first file', 1), expected('second.jar', 'second file', 2), expected('old.jar', 'gamma', 3)]
    const watcher = watchForManualFiles(downloads, want.slice(0, 2))
    await watcher.ready
    const done = collect(watcher)

    // Right name, wrong content: not accepted.
    await writeFile(path.join(downloads, 'first.jar'), 'tampered!!')
    // A browser's in-progress file, renamed when complete, under a different name.
    await writeFile(path.join(downloads, 'first (1).jar.crdownload'), 'first file')
    await rename(path.join(downloads, 'first (1).jar.crdownload'), path.join(downloads, 'first (1).jar'))
    await writeFile(path.join(downloads, 'second.jar'), 'second file')

    const matches = await done
    expect(matches.map((m) => [path.basename(m.file), m.expected.fileId]).toSorted()).toEqual([
      ['first (1).jar', 1],
      ['second.jar', 2],
    ])
    expect(watcher.pending()).toEqual([])
  })

  it('ignores files that were already there unless asked, and stops on abort', async () => {
    await writeFile(path.join(downloads, 'old.jar'), 'gamma')
    const want = [expected('old.jar', 'gamma', 3)]

    const controller = new AbortController()
    const watcher = watchForManualFiles(downloads, want, { signal: controller.signal })
    await watcher.ready
    const done = collect(watcher)
    await new Promise((r) => setTimeout(r, 100))
    controller.abort()
    expect(await done).toEqual([])
    expect(watcher.pending()).toHaveLength(1)

    const existing = watchForManualFiles(downloads, want, { includeExisting: true })
    expect((await collect(existing)).map((m) => m.sha1)).toEqual([sha('sha1', 'gamma')])
  })
})

describe('watchForManualFiles without watcher events', () => {
  it('still finds new files through the safety poll', async () => {
    const want = [expected('late.jar', 'late file', 9)]
    const watcher = watchForManualFiles(downloads, want, { pollMs: 50 })
    await watcher.ready
    const done = collect(watcher)
    // Write through a temp name and rename: the pattern FSEvents is worst at reporting.
    await writeFile(path.join(downloads, 'late.jar.part'), 'late file')
    await rename(path.join(downloads, 'late.jar.part'), path.join(downloads, 'late.jar'))
    expect((await done).map((m) => m.expected.fileId)).toEqual([9])
  })
})
