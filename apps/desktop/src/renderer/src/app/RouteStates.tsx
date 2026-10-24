import { useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'
import { Button, EmptyState, Spinner } from '@/ui'

/** Shown while a lazy route chunk loads (only after a short delay, so fast loads never flash). */
export function RoutePending() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Spinner size={20} label="Loading" />
    </div>
  )
}

/**
 * Route-level error boundary. Never reloads automatically (performance.md V5): the user chooses
 * to reload the view.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <EmptyState
      icon={<AlertTriangle />}
      title="This view couldn’t be displayed"
      description={error instanceof Error ? error.message : String(error)}
      actions={
        <>
          <Button onClick={() => navigator.clipboard?.writeText(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))}>
            Copy Details
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              reset()
              router.invalidate()
            }}
          >
            Reload View
          </Button>
        </>
      }
    />
  )
}

/** Inline query error with Retry, for data that failed to load inside a working view. */
export function QueryError({ error, onRetry, what = 'this' }: { error: unknown; onRetry: () => void; what?: string }) {
  return (
    <EmptyState
      icon={<AlertTriangle />}
      title={`Couldn’t load ${what}`}
      description={error instanceof Error ? error.message : 'Something went wrong.'}
      actions={<Button onClick={onRetry}>Try Again</Button>}
    />
  )
}
