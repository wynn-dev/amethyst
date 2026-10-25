import { create } from 'zustand'
import type { LaunchOptions, LaunchStep } from '@shared/services'
import type { Events } from '@shared/events'
import { api } from '@/lib/rpc'
import { describeError, errorCode, errorDetails, toastError } from '@/lib/error-messages'
import { toast } from '@/ui/toast-store'
import { queryClient } from './query'
import { accountsQuery } from './accounts'

/*
 * The launch state machine, per instance, fed by `launch:state` (and `launch.listRunning()` on
 * start-up and after a runtime restart):
 *
 *   idle → preparing(step…) → running(ready: false → true) → exited
 *                      └────→ failed(code) ──→ a prompt (LaunchPrompt) or a toast
 */

export interface ExitInfo {
  code: number | null
  signal: string | null
  crashed: boolean
  killed: boolean
  crashReportPath: string | null
  durationMs: number
  nativeLoadError: 'architecture' | 'unsatisfied-link' | null
  at: number
}

export interface LaunchEntry {
  launchId: string
  phase: 'preparing' | 'running' | 'exited' | 'failed'
  step: LaunchStep | null
  pid: number
  startedAt: number
  ready: boolean
  /** The last exit of this instance (kept after the next launch starts until it exits). */
  exit?: ExitInfo
  failure?: { code: string; message: string }
}

export const useLaunchStore = create<{ byInstance: Record<string, LaunchEntry> }>()(() => ({ byInstance: {} }))

function setEntry(instanceId: string, fn: (prev: LaunchEntry | undefined) => LaunchEntry) {
  const byInstance = useLaunchStore.getState().byInstance
  useLaunchStore.setState({ byInstance: { ...byInstance, [instanceId]: fn(byInstance[instanceId]) } })
}

/** Window-specific reactions (navigate, focus, notify); set by the main window's shell. */
export interface LaunchEventHandler {
  started?(instanceId: string): void
  exited?(instanceId: string, exit: ExitInfo): void
}
let handler: LaunchEventHandler = {}
export function setLaunchEventHandler(h: LaunchEventHandler): void {
  handler = h
}

export function applyLaunchState(e: Events['launch:state']): void {
  const { instanceId, launchId } = e
  switch (e.state) {
    case 'preparing':
      setEntry(instanceId, (p) => ({ ...base(p, launchId), phase: 'preparing', step: e.step }))
      return
    case 'running': {
      const first = useLaunchStore.getState().byInstance[instanceId]?.phase !== 'running'
      setEntry(instanceId, (p) => ({ ...base(p, launchId), phase: 'running', step: null, pid: e.pid, startedAt: e.startedAt, ready: e.ready }))
      if (first) handler.started?.(instanceId)
      return
    }
    case 'exited': {
      const exit: ExitInfo = {
        code: e.code,
        signal: e.signal,
        crashed: e.crashed,
        killed: e.killed,
        crashReportPath: e.crashReportPath,
        durationMs: e.durationMs,
        nativeLoadError: e.nativeLoadError,
        at: Date.now(),
      }
      setEntry(instanceId, (p) => ({ ...base(p, launchId), phase: 'exited', step: null, ready: false, exit }))
      handler.exited?.(instanceId, exit)
      return
    }
    case 'failed':
      setEntry(instanceId, (p) => ({ ...base(p, launchId), phase: 'failed', step: null, failure: { code: e.code, message: e.message } }))
  }
}

function base(prev: LaunchEntry | undefined, launchId: string): LaunchEntry {
  const same = prev?.launchId === launchId
  return {
    launchId,
    phase: prev?.phase ?? 'preparing',
    step: same ? (prev?.step ?? null) : null,
    pid: same ? (prev?.pid ?? 0) : 0,
    startedAt: same ? (prev?.startedAt ?? 0) : 0,
    ready: same ? (prev?.ready ?? false) : false,
    ...(prev?.exit ? { exit: prev.exit } : {}),
  }
}

export async function reloadRunning(): Promise<void> {
  try {
    const running = await api.launch.listRunning()
    const byInstance = { ...useLaunchStore.getState().byInstance }
    for (const [id, entry] of Object.entries(byInstance)) {
      if ((entry.phase === 'running' || entry.phase === 'preparing') && !running.some((r) => r.instanceId === id)) byInstance[id] = { ...entry, phase: 'exited', ready: false }
    }
    for (const r of running) {
      byInstance[r.instanceId] = { ...byInstance[r.instanceId], launchId: r.launchId, phase: r.phase, step: r.step, pid: r.pid, startedAt: r.startedAt, ready: r.ready }
    }
    useLaunchStore.setState({ byInstance })
  } catch {
    // Retried on `runtime:restarted`.
  }
}

/** The launch entry of one instance (re-renders only when it changes). */
export function useLaunchEntry(instanceId: string | undefined): LaunchEntry | undefined {
  return useLaunchStore((s) => (instanceId ? s.byInstance[instanceId] : undefined))
}

/* ------------------------------------------------------------------------------------------ */
/* Prompts                                                                                      */
/* ------------------------------------------------------------------------------------------ */

type Target = { id: string; name: string }

export type LaunchPrompt =
  | { kind: 'no-account'; instance: Target }
  | { kind: 'java-required'; instance: Target; major: number; options?: LaunchOptions }
  | { kind: 'natives-unavailable'; instance: Target; message: string }
  | { kind: 'sign-in'; instance: Target; accountId?: string }
  | { kind: 'msa-not-approved'; instance: Target }
  | { kind: 'error'; instance: Target; title: string; message?: string; code?: string; details: string }

export const useLaunchPrompt = create<{ prompt: LaunchPrompt | null }>()(() => ({ prompt: null }))
export const closeLaunchPrompt = () => useLaunchPrompt.setState({ prompt: null })
const showPrompt = (prompt: LaunchPrompt) => useLaunchPrompt.setState({ prompt })

/** Turn a typed launch failure into the matching prompt (or a toast for small things). */
export function promptForLaunchError(instance: Target, e: unknown, options?: LaunchOptions): void {
  const code = errorCode(e)
  const details = errorDetails(e)
  switch (code) {
    case 'ECANCELLED':
      return
    case 'EBUSY':
      toast({ kind: 'info', title: describeError(e).title })
      return
    case 'EACCOUNT_REQUIRED':
      return showPrompt({ kind: 'no-account', instance })
    case 'EJAVA_REQUIRED':
      return showPrompt({ kind: 'java-required', instance, major: typeof details.major === 'number' ? details.major : 0, ...(options ? { options } : {}) })
    case 'ENATIVES_UNAVAILABLE':
      return showPrompt({ kind: 'natives-unavailable', instance, message: e instanceof Error ? e.message : String(e) })
    case 'ESIGN_IN_REQUIRED':
      return showPrompt({ kind: 'sign-in', instance, ...(typeof details.accountId === 'string' ? { accountId: details.accountId } : {}) })
    case 'EMSA_APP_NOT_APPROVED':
      return showPrompt({ kind: 'msa-not-approved', instance })
    default: {
      const f = describeError(e)
      return showPrompt({
        kind: 'error',
        instance,
        title: f.title,
        ...(f.message ? { message: f.message } : {}),
        ...(code ? { code } : {}),
        details: `${code ?? 'Error'}: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Actions                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Play: pre-checks the account (instant prompt instead of after a long install), then launches. */
export async function launchInstance(instance: Target, options?: LaunchOptions): Promise<void> {
  try {
    if (!options?.accountId) {
      const accounts = await queryClient.fetchQuery({ ...accountsQuery, staleTime: 5_000 })
      if (accounts.length === 0) return showPrompt({ kind: 'no-account', instance })
    }
  } catch {
    // Let the runtime decide (it reports EACCOUNT_REQUIRED itself).
  }
  setEntry(instance.id, (p) => ({ ...base(p, p?.launchId ?? ''), phase: 'preparing', step: p?.phase === 'preparing' ? p.step : null }))
  try {
    await api.launch.launch(instance.id, options)
  } catch (e) {
    // The `launch:state failed` event already moved the entry; make sure an early rejection does too.
    const entry = useLaunchStore.getState().byInstance[instance.id]
    if (entry?.phase === 'preparing') setEntry(instance.id, (p) => ({ ...base(p, p?.launchId ?? ''), phase: 'failed', failure: { code: errorCode(e) ?? 'ELAUNCH_FAILED', message: String(e) } }))
    promptForLaunchError(instance, e, options)
  }
}

export async function stopInstance(instance: Target, force = false): Promise<void> {
  try {
    await api.launch.kill(instance.id, { force })
  } catch (e) {
    toastError(e, `Couldn’t stop “${instance.name}”`)
  }
}

/** Download the Java a launch asked for, then launch again. */
export async function installJavaAndLaunch(instance: Target, major: number, options?: LaunchOptions): Promise<void> {
  closeLaunchPrompt()
  toast({ kind: 'info', title: `Downloading Java ${major}`, message: 'Progress is shown in Activity. The game starts when it’s done.' })
  try {
    await api.java.installRuntime(major)
  } catch (e) {
    toastError(e, `Couldn’t install Java ${major}`)
    return
  }
  await launchInstance(instance, options)
}

export const STEP_LABELS: Record<LaunchStep, string> = {
  resolve: 'Preparing',
  install: 'Installing the game',
  java: 'Choosing Java',
  natives: 'Preparing native libraries',
  verify: 'Checking files',
  repair: 'Repairing files',
  account: 'Signing in',
  prelaunch: 'Running the pre-launch command',
  build: 'Building the command line',
  spawn: 'Starting Java',
}
