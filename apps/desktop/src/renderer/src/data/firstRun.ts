import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TelemetryConsent } from '@shared/services'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import { queryClient } from './query'
import { settingsKey, type AppSettings } from './settings'

export const FIRST_RUN_STEPS = ['welcome', 'appearance', 'account', 'java', 'privacy', 'done'] as const
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number]

interface FirstRunStore {
  completed: boolean
  /** The step to resume at if the app quit during first run. */
  step: FirstRunStep
  setStep: (step: FirstRunStep) => void
  complete: () => void
  /** Back to the start (the data root was reset or is new). */
  restart: () => void
}

/**
 * First-run progress. The source of truth is the runtime's `settings.privacy.prompted` (set when
 * the Privacy step is answered through `telemetry.setConsent`); a local mirror lets the router
 * decide synchronously at first paint, and the step to resume at is kept locally.
 */
export const useFirstRun = create<FirstRunStore>()(
  persist(
    (set) => ({
      completed: false,
      step: 'welcome',
      setStep: (step) => set({ step }),
      complete: () => set({ completed: true, step: 'done' }),
      restart: () => set({ completed: false, step: 'welcome' }),
    }),
    { name: 'amethyst:first-run', version: 1 },
  ),
)

/**
 * Answer the Privacy step: persists consent (and `privacy.prompted`) in the runtime. Nothing is
 * sent before this call, and continuing without changes stores "no" for both.
 */
export async function answerPrivacy(consent: TelemetryConsent): Promise<boolean> {
  try {
    await api.telemetry.setConsent(consent)
    queryClient.setQueryData<AppSettings>(settingsKey, (s) => (s ? { ...s, privacy: { usageData: consent.usage, crashReports: consent.crashes, prompted: true } } : s))
    return true
  } catch (e) {
    toastError(e, 'Couldn’t save your privacy choice')
    return false
  }
}

/**
 * Keep the local mirror in line with the runtime: a data root whose consent was never asked
 * (fresh install, reset settings) goes back to first run; one that already answered skips it.
 * Returns where the window should be.
 */
export function reconcileFirstRun(settings: AppSettings): 'first-run' | 'app' {
  const s = useFirstRun.getState()
  if (!settings.privacy.prompted) {
    // Mid-way through first run (before Privacy) is fine; a completed mirror is stale.
    if (s.completed) s.restart()
    return 'first-run'
  }
  if (!s.completed && FIRST_RUN_STEPS.indexOf(s.step) < FIRST_RUN_STEPS.indexOf('done')) s.complete()
  return useFirstRun.getState().completed ? 'app' : 'first-run'
}
