import { release } from 'node:os'
import { darwinToMacosVersion, type Platform } from '@amethyst/game'
import type { HttpClient } from '@amethyst/net'
import type { TaskContext } from '@amethyst/task'
import { abortReason } from './abort'

/** Options shared by every installer. */
export interface InstallOptions {
  /** The shared Minecraft directory containing `versions/`, `libraries/` and `assets/`. */
  root: string
  /** Cancels the install. Defaults to `ctx.signal`. */
  signal?: AbortSignal
  /** Progress is reported here, split into weighted child tasks. */
  ctx?: TaskContext
  /** HTTP client (defaults to the process-wide client of `@amethyst/net`). */
  http?: HttpClient
  /** Platform for rule evaluation (default: macOS arm64). */
  platform?: Platform
  /** Parallel downloads (default 16). */
  concurrency?: number
  /** Base URL for asset objects (default `https://resources.download.minecraft.net/`). */
  assetsBaseUrl?: string
  /**
   * The `.install-lock` timestamp of an earlier successful install: files not modified since are
   * trusted without hashing (except the client jar).
   */
  trustedBefore?: number
}

/** The public asset object host. */
export const ASSETS_BASE_URL = 'https://resources.download.minecraft.net/'

export function signalOf(options: Pick<InstallOptions, 'signal' | 'ctx'>): AbortSignal | undefined {
  return options.signal ?? options.ctx?.signal
}

/**
 * The default install platform: macOS on arm64 (the JVM Amethyst installs), with the product
 * version derived from the kernel release. Pass `platform` explicitly to install for an x86_64 JVM.
 */
export function defaultPlatform(): Platform {
  return { name: 'osx', version: darwinToMacosVersion(release()), arch: 'arm64' }
}

export function platformOf(options: Pick<InstallOptions, 'platform'>): Platform {
  return options.platform ?? defaultPlatform()
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

/**
 * Run `fn` as a weighted child task of `ctx` (or directly when there is no task context).
 * `weight` is usually the step's size in MiB, so the parent's bar moves by bytes.
 */
export function step<T>(ctx: TaskContext | undefined, name: string, weight: number, fn: (ctx: TaskContext | undefined) => Promise<T>, params?: Record<string, string | number>): Promise<T> {
  if (!ctx) return fn(undefined)
  return ctx.child(name, (child) => fn(child), { weight: Math.max(1, weight), params })
}

/** Weight for a step of `bytes` bytes: its size in MiB, at least 1. */
export function weightOf(bytes: number | undefined): number {
  return Math.max(1, Math.round((bytes ?? 0) / (1024 * 1024)))
}

/**
 * Await every promise, then throw the first failure (in argument order). Unlike `Promise.all`,
 * no branch is left running in the background when another one fails.
 */
export async function settleAll<T extends readonly unknown[]>(promises: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(promises)
  for (const r of results) if (r.status === 'rejected') throw r.reason
  return results.map((r) => (r as PromiseFulfilledResult<unknown>).value) as unknown as T
}
