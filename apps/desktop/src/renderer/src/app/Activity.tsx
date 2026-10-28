import { useState } from 'react'
import { ArrowDownToLine, ChevronRight, X, CheckCircle2, XCircle, CircleSlash, Circle } from 'lucide-react'
import { Button, DitherBar, EmptyState, IconButton, Popover, cn } from '@/ui'
import { installInstance } from '@/data/instances'
import { javaActions } from '@/data/java'
import { taskActions, useTaskStore, useTaskSummary, useTasks } from '@/data/tasks'
import type { TaskSnapshot, TaskState } from '@/data/types'
import { copyToClipboard } from './clipboard'
import { formatBytes, formatRelative } from './visuals'
import { useUi } from './ui-store'

const active = (s: TaskState) => s === 'running' || s === 'paused' || s === 'queued'

/** Retry for the tasks that can be started again from here. */
function retryOf(task: TaskSnapshot): (() => void) | undefined {
  const view = useTaskStore.getState().byId[task.id]
  if (!view) return undefined
  if (task.name === 'install.run' && task.instanceId) return () => void installInstance({ id: task.instanceId!, name: String(view.params.name ?? 'instance') })
  if (task.name === 'java.install' && typeof view.params.major === 'number') return () => void javaActions.install(view.params.major as number)
  return undefined
}

function eta(ms?: number) {
  if (!ms) return undefined
  const m = Math.round(ms / 60_000)
  return m < 1 ? 'less than a minute left' : `${m} min left`
}

/** Toolbar button: a small dot while work runs (red when something failed); opens the Activity popover. */
export function ActivityButton() {
  const open = useUi((s) => s.activity)
  const set = useUi((s) => s.set)
  const { running: runningCount, fraction: overall, failed } = useTaskSummary()
  const running = { length: runningCount }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => set({ activity: o })}
      label="Activity"
      align="end"
      width={320}
      trigger={
        <button
          type="button"
          aria-label={running.length ? `Activity: ${running.length} running, ${Math.round((overall ?? 0) * 100)}%` : 'Activity'}
          aria-keyshortcuts="Alt+Meta+A"
          title="Activity (⌥⌘A)"
          className="relative flex size-7 items-center justify-center rounded-[7px] text-label-2 transition-colors duration-150 hover:bg-hover hover:text-label data-[state=open]:bg-fill data-[state=open]:text-label"
        >
          <ArrowDownToLine className="size-[15px]" />
          {(failed > 0 || running.length > 0) && (
            <span className={cn('absolute top-[5px] right-[5px] size-[5px] rounded-full ring-[1.5px] ring-[var(--color-window)]', failed > 0 ? 'bg-red' : 'bg-accent')} />
          )}
        </button>
      }
    >
      <LiveActivityPanel />
    </Popover>
  )
}

/** The popover body: subscribes to every task only while it is open. */
function LiveActivityPanel() {
  const { data } = useTasks()
  return <ActivityPanel tasks={data} />
}

export function ActivityPanel({ tasks }: { tasks: TaskSnapshot[] }) {
  const inProgress = tasks.filter((t) => active(t.state))
  const recent = tasks.filter((t) => !active(t.state))
  return (
    <div className="flex max-h-[min(520px,70vh)] flex-col">
      <div className="flex items-baseline justify-between px-3.5 pt-[11px] pb-1.5">
        <h2 className="text-callout font-semibold">Activity</h2>
        {inProgress.length > 0 && <span className="text-small text-label-3 tabular">{inProgress.length} active</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {tasks.length === 0 && <EmptyState title="No activity" description="Downloads and installs will appear here." className="py-8" />}
        {inProgress.length > 0 && <Group title="In Progress" tasks={inProgress} />}
        {recent.length > 0 && <Group title="Recent" tasks={recent} />}
      </div>
      {recent.length > 0 && (
        <div className="flex justify-end border-t border-separator px-3 py-2">
          <Button size="sm" onClick={() => void taskActions.clearFinished()}>
            Clear Completed
          </Button>
        </div>
      )}
    </div>
  )
}

function Group({ title, tasks }: { title: string; tasks: TaskSnapshot[] }) {
  return (
    <section aria-label={title}>
      <h3 className="px-3.5 pt-2 pb-0.5 text-small font-semibold text-label-3">{title}</h3>
      <ul className="flex flex-col">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </ul>
    </section>
  )
}

const stateIcon: Partial<Record<TaskState, React.ReactNode>> = {
  succeeded: <CheckCircle2 className="size-3 text-green" />,
  failed: <XCircle className="size-3 text-red" />,
  cancelled: <CircleSlash className="size-3 text-label-3" />,
  queued: <Circle className="size-3 text-label-3" />,
}

function TaskRow({ task }: { task: TaskSnapshot }) {
  const [expanded, setExpanded] = useState(false)
  const isActive = active(task.state)
  // Amounts read in small monospaced figures on the right; the state goes under the bar.
  const amount =
    task.bytesTotal !== undefined
      ? `${formatBytes(task.bytesDone ?? 0)} / ${formatBytes(task.bytesTotal)}`
      : task.progress !== undefined
        ? `${Math.round(task.progress * 100)}%`
        : undefined
  const note = task.state === 'paused' ? 'Paused' : eta(task.etaMs)

  return (
    <li className="border-t border-separator px-3.5 pt-2 pb-2.5 first:border-t-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <p className="truncate text-compact">{task.title}</p>
            {task.children.length > 0 && (
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? 'Hide steps' : 'Show steps'}
                onClick={() => setExpanded((e) => !e)}
                className="flex size-4 shrink-0 items-center justify-center rounded text-label-3 hover:text-label-2"
              >
                <ChevronRight className={cn('size-3 transition-transform duration-150', expanded && 'rotate-90')} strokeWidth={2} />
              </button>
            )}
            {isActive && amount && <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] text-label-2 tabular">{amount}</span>}
          </div>
          {task.subtitle && isActive && <p className="truncate text-small text-label-3">{task.subtitle}</p>}
          {isActive && <DitherBar value={task.progress} label={task.title} muted={task.state === 'paused'} className="mt-[7px]" />}
          {isActive && note && <p className="mt-1 text-small text-label-3 tabular">{note}</p>}
          {task.state === 'succeeded' && task.finishedAt && <p className="text-small text-label-3">Finished {formatRelative(task.finishedAt)}</p>}
          {task.state === 'failed' && task.error && (
            <div className="mt-0.5">
              <p className="text-small text-red">{task.error.message}</p>
              <div className="mt-1.5 flex gap-2">
                {retryOf(task) && (
                  <Button
                    size="sm"
                    onClick={() => {
                      void taskActions.dismiss(task.id)
                      retryOf(task)?.()
                    }}
                  >
                    Retry
                  </Button>
                )}
                <Button size="sm" variant="borderless" onClick={() => copyToClipboard(`${task.title}\n${task.error?.details ?? task.error?.message}`, 'Copied details')}>
                  Copy Details
                </Button>
                <Button size="sm" variant="borderless" onClick={() => void taskActions.dismiss(task.id)}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}
          {expanded && (
            <ul className="mt-2 flex flex-col gap-1 border-l border-separator pl-2.5">
              {task.children.map((c) => (
                <li key={c.id} className="flex items-center gap-1.5 text-small text-label-2">
                  {c.state === 'running' ? <span className="size-1.5 rounded-full bg-accent" aria-hidden /> : stateIcon[c.state]}
                  <span className="truncate">{c.title}</span>
                  {c.progress !== undefined && c.state === 'running' && <span className="ml-auto font-mono text-[11px] tabular">{Math.round(c.progress * 100)}%</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        {isActive && task.cancellable && (
          <div className="flex shrink-0 items-center">
            <IconButton label="Cancel" size="sm" onClick={() => void taskActions.cancel(task.id)}>
              <X />
            </IconButton>
          </div>
        )}
        {!isActive && task.state !== 'failed' && <span className="mt-0.5">{stateIcon[task.state]}</span>}
      </div>
    </li>
  )
}
