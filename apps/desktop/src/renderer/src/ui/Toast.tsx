import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XOctagon } from 'lucide-react'
import { cn } from './cn'
import { toasts as defaultStore, type Toast, type ToastStore } from './toast-store'

const icons = {
  success: <CheckCircle2 className="size-[18px] text-green" />,
  info: <Info className="size-[18px] text-blue" />,
  warning: <AlertTriangle className="size-[18px] text-orange" />,
  error: <XOctagon className="size-[18px] text-red" />,
}

function ToastView({ toast, paused, store }: { toast: Toast; paused: boolean; store: ToastStore }) {
  // A single timeout per toast, restarted on merge and paused while the stack is hovered.
  const remaining = useRef(toast.duration)

  // Declared before the timer effect so a merge resets the budget before the timer restarts.
  useEffect(() => {
    remaining.current = toast.duration
  }, [toast.revision, toast.duration])

  useEffect(() => {
    if (paused || toast.duration === 0) return
    const started = performance.now()
    const t = setTimeout(() => store.dismiss(toast.id), remaining.current)
    return () => {
      clearTimeout(t)
      remaining.current -= performance.now() - started
    }
  }, [paused, toast.id, toast.duration, toast.revision, store])

  return (
    <li
      role={toast.kind === 'error' ? 'alert' : 'status'}
      aria-atomic
      className="pointer-events-auto flex w-[340px] animate-toast-in items-start gap-2.5 rounded-xl bg-raised p-3 shadow-popover backdrop-blur-2xl"
    >
      <span className="mt-px">{icons[toast.kind]}</span>
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold">
          {toast.title}
          {toast.count > 1 && <span className="ml-1.5 rounded-full bg-fill-2 px-1.5 text-small font-medium text-label-2">×{toast.count}</span>}
        </p>
        {toast.message && <p className="mt-0.5 text-callout text-label-2">{toast.message}</p>}
        {toast.actions.length > 0 && (
          <div className="mt-2 flex gap-3">
            {toast.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="text-callout font-medium text-accent hover:underline"
                onClick={() => {
                  a.onClick()
                  store.dismiss(toast.id)
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => store.dismiss(toast.id)}
        className="-mt-0.5 -mr-0.5 flex size-5 items-center justify-center rounded-full text-label-3 hover:bg-fill hover:text-label-2"
      >
        <X className="size-3" strokeWidth={2.5} />
      </button>
    </li>
  )
}

/** Bottom-trailing toast stack. Newest on top, at most three, each fully visible. */
export function ToastViewport({ store = defaultStore, className }: { store?: ToastStore; className?: string }) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [paused, setPaused] = useState(false)
  return (
    <section aria-label="Notifications" className={cn('pointer-events-none absolute right-4 bottom-4 z-50', className)}>
      <ol
        aria-live="polite"
        className="flex flex-col gap-2"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
      >
        {items.map((t) => (
          <ToastView key={t.id} toast={t} paused={paused} store={store} />
        ))}
      </ol>
    </section>
  )
}
