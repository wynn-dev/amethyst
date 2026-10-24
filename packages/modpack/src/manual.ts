/* oxlint-disable no-await-in-loop -- candidate files are hashed one at a time */
/**
 * Manual downloads for CurseForge files whose authors block third-party distribution
 * (`modpacks.md` §5.3, `DECISIONS.md`). The user downloads each file from its page; Amethyst
 * accepts the downloaded file by **hash** (CurseForge supplies SHA-1 and MD5), never by name
 * alone.
 *
 * - {@link matchManualFiles}: match paths the user picked or dropped against the expected files.
 * - {@link watchForManualFiles}: watch a folder (default `~/Downloads`) and report new files that
 *   match, checking name and size first (cheap) and the hash last.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { isAbortError, throwIfAborted } from './errors'
import type { ManualDownload } from './types'
import { hashLocal } from './util'

/** A user-supplied file that matches an expected manual download. */
export interface ManualFileMatch {
  expected: ManualDownload
  /** Absolute path of the user's file. */
  file: string
  sha1: string
}

/** A user-supplied file that matches nothing. */
export interface RejectedManualFile {
  file: string
  reason: string
}

function hashMatches(expected: ManualDownload, h: { sha1: string; md5?: string; size: number }): boolean {
  if (expected.size > 0 && h.size !== expected.size) return false
  if (expected.sha1) return expected.sha1.toLowerCase() === h.sha1
  if (expected.md5 && h.md5) return expected.md5.toLowerCase() === h.md5
  return false
}

/**
 * Match local files against expected manual downloads by SHA-1 (or MD5 when CurseForge gave
 * no SHA-1) and size. Each expected file is matched at most once.
 */
export async function matchManualFiles(
  files: readonly string[],
  expected: readonly ManualDownload[],
  signal?: AbortSignal,
): Promise<{ matched: ManualFileMatch[]; rejected: RejectedManualFile[] }> {
  const open = [...expected]
  const matched: ManualFileMatch[] = []
  const rejected: RejectedManualFile[] = []
  const needMd5 = expected.some((e) => !e.sha1 && e.md5)
  for (const raw of files) {
    throwIfAborted(signal)
    const file = path.resolve(raw)
    const st = await stat(file).catch(() => undefined)
    if (!st?.isFile()) {
      rejected.push({ file, reason: 'not a file' })
      continue
    }
    const h = await hashLocal(file, { md5: needMd5 }, signal)
    const i = open.findIndex((e) => hashMatches(e, h))
    if (i < 0) {
      rejected.push({ file, reason: 'does not match any missing file (hash or size differs)' })
      continue
    }
    const [hit] = open.splice(i, 1) as [ManualDownload]
    matched.push({ expected: hit, file, sha1: h.sha1 })
  }
  return { matched, rejected }
}

/** Options for {@link watchForManualFiles}. */
export interface WatchManualOptions {
  /** Stops the watcher; iteration then ends normally. */
  signal?: AbortSignal
  /** Also consider files already in the folder when watching starts (default false). */
  includeExisting?: boolean
  /** Safety rescan interval for events the OS watcher drops (default 2000 ms). */
  pollMs?: number
}

/** A running folder watcher. Iterate it to receive matches; it ends when every file matched or it is closed. */
export interface ManualFileWatcher extends AsyncIterable<ManualFileMatch> {
  /** Resolves once the folder is watched and its current contents are recorded. */
  readonly ready: Promise<void>
  /** Expected files that have not matched yet. */
  pending(): ManualDownload[]
  /** Stop watching and end the iteration. */
  close(): void
}

const stamp = (st: { size: number; mtimeMs: number }) => `${st.size}:${st.mtimeMs}`

/** Browser temporary download names; they are renamed when complete. */
const PARTIAL = /\.(crdownload|download|part|partial|tmp)$/i

/**
 * Watch `dir` (default `~/Downloads`) for files matching `expected`. A new or changed file is a
 * candidate when its name equals an expected file name or its size equals an expected size;
 * candidates are then hashed and matched like {@link matchManualFiles}. In-progress browser
 * downloads (`.crdownload`, `.download`, `.part`) are ignored until renamed.
 *
 * On macOS, reading `~/Downloads` triggers a privacy consent prompt; explain why before the first
 * call. Watching starts immediately; await {@link ManualFileWatcher.ready} before relying on it.
 */
export function watchForManualFiles(
  dir: string = path.join(homedir(), 'Downloads'),
  expected: readonly ManualDownload[],
  options: WatchManualOptions = {},
): ManualFileWatcher {
  const root = path.resolve(dir)
  const open = [...expected]
  const known = new Map<string, string>()
  const queue: ManualFileMatch[] = []
  let wake: (() => void) | undefined
  let closed = false
  let failure: unknown
  let watcher: FSWatcher | undefined
  let chain: Promise<void> = Promise.resolve()
  let rescanTimer: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal

  const notify = () => {
    const w = wake
    wake = undefined
    w?.()
  }
  const close = () => {
    if (closed) return
    closed = true
    watcher?.close()
    clearTimeout(rescanTimer)
    clearInterval(poll)
    controller.abort()
    notify()
  }
  signal.addEventListener('abort', close, { once: true })

  const check = async (name: string): Promise<void> => {
    if (closed || PARTIAL.test(name) || name.startsWith('.')) return
    const file = path.join(root, name)
    const st = await stat(file).catch(() => undefined)
    if (!st?.isFile()) return
    if (known.get(name) === stamp(st)) return
    known.set(name, stamp(st))
    const lower = name.toLowerCase()
    const candidates = open.filter((e) => e.fileName.toLowerCase() === lower || e.size === st.size)
    if (candidates.length === 0) return
    const h = await hashLocal(file, { md5: candidates.some((e) => !e.sha1 && e.md5) }, signal)
    const hit = candidates.find((e) => hashMatches(e, h))
    if (!hit || closed) return
    open.splice(open.indexOf(hit), 1)
    queue.push({ expected: hit, file, sha1: h.sha1 })
    notify()
  }
  const enqueue = (name: string) => {
    chain = chain
      .then(() => check(name))
      .catch((e: unknown) => {
        if (!isAbortError(e)) {
          // A file vanishing mid-hash is normal for a Downloads folder; anything else ends the watch.
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') failure ??= e
        }
      })
      .then(() => {
        if (open.length === 0 || failure) close()
        notify()
      })
  }
  const rescan = async () => {
    if (closed) return
    for (const name of await readdir(root).catch(() => [] as string[])) enqueue(name)
  }
  // macOS FSEvents coalesces events and often reports only one name for a rename (or none), so
  // filename events are a hint: every event also triggers a debounced rescan, and a slow poll
  // catches anything the watcher missed entirely. Unchanged files cost one stat (see `known`).
  const scheduleRescan = () => {
    if (closed || rescanTimer) return
    rescanTimer = setTimeout(() => {
      rescanTimer = undefined
      void rescan()
    }, 150)
  }

  const ready = (async () => {
    if (open.length === 0) return close()
    try {
      watcher = fsWatch(root, { persistent: false }, (_event, filename) => {
        if (closed) return
        if (filename) enqueue(String(filename))
        scheduleRescan()
      })
      watcher.on('error', (e) => {
        failure ??= e
        close()
      })
    } catch (e) {
      failure = e
      close()
      return
    }
    if (options.includeExisting) {
      await rescan()
    } else {
      for (const name of await readdir(root).catch(() => [] as string[])) {
        const st = await stat(path.join(root, name)).catch(() => undefined)
        if (st?.isFile() && !known.has(name)) known.set(name, stamp(st))
      }
    }
    // Start polling only once the baseline is recorded, so existing files are never matched.
    if (!closed) {
      poll = setInterval(() => void rescan(), options.pollMs ?? 2_000)
      poll.unref?.()
    }
  })()

  return {
    ready,
    pending: () => [...open],
    close,
    async *[Symbol.asyncIterator]() {
      try {
        await ready
        while (true) {
          if (queue.length > 0) {
            yield queue.shift() as ManualFileMatch
            continue
          }
          if (closed) break
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
        if (failure) throw failure
      } finally {
        close()
      }
    },
  }
}
