import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const FIRST_RUN_STEPS = ['welcome', 'appearance', 'account', 'java', 'privacy', 'done'] as const
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number]

interface FirstRunStore {
  completed: boolean
  /** The step to resume at if the app quit during first run. */
  step: FirstRunStep
  setStep: (step: FirstRunStep) => void
  complete: () => void
}

/**
 * First-run progress, stored locally for now.
 * TODO(wire): replace with api.settings.get().firstRun → { completed: boolean; step: FirstRunStep } and
 * api.settings.update({ firstRun }). Telemetry must stay off until `privacy` has been completed.
 */
export const useFirstRun = create<FirstRunStore>()(
  persist(
    (set) => ({
      completed: false,
      step: 'welcome',
      setStep: (step) => set({ step }),
      complete: () => set({ completed: true, step: 'done' }),
    }),
    { name: 'amethyst:first-run', version: 1 },
  ),
)
