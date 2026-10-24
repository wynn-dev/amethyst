import { resolve } from 'node:path'
import { mapLimit } from '@amethyst/task'
import { anySignal, downloadItem, type ProgressSink } from './download'
import { abortReason, DownloadError, type DownloadFailure } from './errors'
import type { DownloadItem, DownloadManyOptions, DownloadStats } from './types'

/**
 * Download many files with a bounded pool (default 16 at once).
 *
 * Items are fed to the pool lazily: at most `concurrency` downloads (and open files) exist at a time,
 * and each holds at most a few hundred KiB of buffers, so thousands of assets stay within a few MB.
 * Duplicate destinations are collapsed (the last item wins).
 *
 * Progress is reported to `ctx` in bytes: the total starts as the sum of known `size`s, grows as
 * response headers reveal unknown sizes, and shrinks when a file is skipped. The message shows
 * `done/total files`. The task tree throttles notifications, so per-chunk updates are cheap.
 *
 * Every item runs to completion or failure independently; failures are collected into a
 * {@link DownloadError}. With `failFast`, the first failure cancels the rest instead. Either way the
 * promise settles only after all in-flight work (writes, cleanup) has finished. Cancellation
 * rejects with the abort reason.
 */
export async function downloadMany(items: Iterable<DownloadItem>, options: DownloadManyOptions = {}): Promise<DownloadStats> {
  const startedAt = performance.now()
  const ctx = options.ctx
  const outer = anySignal(options.signal, ctx?.signal)
  const failFast = new AbortController()
  const signal = anySignal(outer, failFast.signal) as AbortSignal

  const byDest = new Map<string, DownloadItem>()
  for (const item of items) byDest.set(resolve(item.dest), item)
  const list = [...byDest.values()]

  const stats: DownloadStats = { bytes: 0, files: 0, skipped: 0, durationMs: 0 }
  const failures: DownloadFailure[] = []
  let done = 0
  let total = 0
  for (const item of list) total += item.size ?? 0
  let settled = 0
  const message = () => `${settled}/${list.length} files`
  const sink: ProgressSink = {
    progress(delta) {
      done += delta
      ctx?.update(done, total)
    },
    total(bytes) {
      total += bytes
      ctx?.update(done, total)
    },
  }
  ctx?.update(0, total, message())

  const itemOptions = { ...options, signal, ctx: undefined }
  const one = async (item: DownloadItem): Promise<void> => {
    try {
      const result = await downloadItem(item, itemOptions, sink)
      stats.bytes += result.bytes
      if (result.skipped) {
        stats.skipped++
        total -= item.size ?? 0
      } else {
        stats.files++
      }
    } catch (e) {
      if (signal.aborted) return
      failures.push({ item, error: e instanceof Error ? e : new Error(String(e)) })
      if (options.failFast) failFast.abort(e)
    } finally {
      settled++
      ctx?.update(done, total, message())
    }
  }

  const active = new Set<Promise<void>>()
  try {
    await mapLimit(
      list,
      Math.max(1, Math.floor(options.concurrency ?? 16)),
      (item) => {
        const p = one(item)
        active.add(p)
        void p.finally(() => active.delete(p))
        return p
      },
      signal,
    )
  } catch {
    // Aborted: fall through and wait for in-flight items to clean up.
  }
  await Promise.allSettled(active)

  stats.durationMs = Math.round(performance.now() - startedAt)
  if (outer?.aborted) throw abortReason(outer)
  if (failures.length > 0) throw new DownloadError(failures, stats)
  return stats
}
