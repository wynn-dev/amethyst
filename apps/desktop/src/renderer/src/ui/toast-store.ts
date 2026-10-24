/**
 * In-app toast queue (ui.md B11). Framework-free so it can be driven from anywhere, including
 * non-React code, and unit tested directly.
 *
 * - At most `MAX_VISIBLE` toasts exist at once. A new toast evicts the oldest one.
 * - A toast identical to a visible one (same kind, title and message) merges into it as ×N
 *   and restarts its timer instead of stacking a duplicate.
 */

export type ToastKind = 'success' | 'info' | 'warning' | 'error'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastInput {
  kind?: ToastKind
  title: string
  message?: string
  /** Up to two actions, e.g. Undo, Show in Finder, Retry, Details. */
  actions?: ToastAction[]
  /** Override the auto-dismiss delay in ms. `0` keeps it until dismissed. */
  duration?: number
}

export interface Toast extends Required<Pick<ToastInput, 'kind' | 'title'>> {
  id: number
  message?: string
  actions: ToastAction[]
  count: number
  duration: number
  /** Bumped whenever the toast is merged, so views can restart their timer. */
  revision: number
}

export const MAX_VISIBLE = 3

export function defaultDuration(kind: ToastKind): number {
  return kind === 'warning' || kind === 'error' ? 10_000 : 5_000
}

type Listener = () => void

export function createToastStore() {
  let toasts: Toast[] = []
  let nextId = 1
  const listeners = new Set<Listener>()
  const emit = () => listeners.forEach((l) => l())

  return {
    subscribe(l: Listener) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    /** Newest first. */
    getSnapshot: () => toasts,
    show(input: ToastInput): number {
      const kind = input.kind ?? 'info'
      const dup = toasts.find((t) => t.kind === kind && t.title === input.title && t.message === input.message)
      if (dup) {
        const merged = { ...dup, count: dup.count + 1, revision: dup.revision + 1 }
        toasts = [merged, ...toasts.filter((t) => t !== dup)]
        emit()
        return dup.id
      }
      const toast: Toast = {
        id: nextId++,
        kind,
        title: input.title,
        message: input.message,
        actions: (input.actions ?? []).slice(0, 2),
        count: 1,
        duration: input.duration ?? defaultDuration(kind),
        revision: 0,
      }
      toasts = [toast, ...toasts].slice(0, MAX_VISIBLE)
      emit()
      return toast.id
    },
    dismiss(id: number) {
      const next = toasts.filter((t) => t.id !== id)
      if (next.length === toasts.length) return
      toasts = next
      emit()
    },
    clear() {
      toasts = []
      emit()
    },
  }
}

export type ToastStore = ReturnType<typeof createToastStore>

/** The app-wide toast queue. */
export const toasts = createToastStore()

/** Shows a toast. Returns its id. */
export const toast = (input: ToastInput) => toasts.show(input)
