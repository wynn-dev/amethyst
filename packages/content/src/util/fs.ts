import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Write `data` to `file` atomically: write a temporary sibling, then rename it over the target. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}
