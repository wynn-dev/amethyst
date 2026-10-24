import { useState } from 'react'
import { ArrowDownToLine, Box, ChevronRight, Coffee, Pause, Play, RefreshCw, ShieldCheck, Upload, X, CheckCircle2, XCircle, CircleSlash, Circle } from 'lucide-react'
import { Button, EmptyState, IconButton, Popover, ProgressBar, ProgressRing, cn, toast } from '@/ui'
import { useTasks } from '@/data/misc'
import { queryClient } from '@/data/query'
import type { TaskSnapshot, TaskState } from '@/data/types'
import { formatBytes, formatRelative } from './visuals'
import { useUi } from './ui-store'

const kindIcon: Record<TaskSnapshot['kind'], React.ReactNode> = {
  install: <Box />,
  download: <ArrowDownToLine />,
  modpack: <Box />,
  java: <Coffee />,
  update: <RefreshCw />,
  export: <Upload />,
  verify: <ShieldCheck />,
}

const active = (s: TaskState) => s === 'running' || s === 'paused' || s === 'queued'

function patchTask(id: string, patch: Partial<TaskSnapshot>) {
  queryClient.setQueryData<TaskSnapshot[]>(['tasks'], (l) => l?.map((t) => (t.id === id ? { ...t, ...patch } : t)))
}

function eta(ms?: number) {
  if (!ms) return undefined
  const m = Math.round(ms / 60_000)
  return m < 1 ? 'less than a minute left' : `${m} min left`
}

/** Toolbar button: a ring showing overall progress while work runs; opens the Activity popover. */
export function ActivityButton() {
  const { data: tasks = [] } = useTasks()
  const open = useUi((s) => s.activity)
  const set = useUi((s) => s.set)
  const running = tasks.filter((t) => t.state === 'running')
  const failed = tasks.filter((t) => t.state === 'failed').length
  const overall = running.length ? running.reduce((a, t) => a + (t.progress ?? 0), 0) / running.length : undefined

  return (
    <Popover
      open={open}
      onOpenChange={(o) => set({ activity: o })}
      label="Activity"
      align="end"
      width={360}
      trigger={
        <button
          type="button"
          aria-label={running.length ? `Activity: ${running.length} running, ${Math.round((overall ?? 0) * 100)}%` : 'Activity'}
          aria-keyshortcuts="Alt+Meta+A"
          title="Activity (⌥⌘A)"
          className="relative flex size-7 items-center justify-center rounded-md text-label-2 hover:bg-fill hover:text-label data-[state=open]:bg-fill-2"
        >
          {running.length ? <ProgressRing value={overall} size={17} stroke={2.25} /> : <ArrowDownToLine className="size-4" />}
          {failed > 0 && <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-red ring-2 ring-[var(--color-window)]" />}
        </button>
      }
    >
      <ActivityPanel tasks={tasks} />
    </Popover>
  )
}

export function ActivityPanel({ tasks }: { tasks: TaskSnapshot[] }) {
  const inProgress = tasks.filter((t) => active(t.state))
  const recent = tasks.filter((t) => !active(t.state))
  return (
    <div className="flex max-h-[min(520px,70vh)] flex-col">
      <div className="flex items-baseline justify-between px-4 pt-3 pb-2">
        <h2 className="text-title3 font-semibold">Activity</h2>
        {inProgress.some((t) => t.state === 'running') && <span className="text-small text-label-2 tabular">12.4 MB/s</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {tasks.length === 0 && <EmptyState title="No activity" description="Downloads and installs will appear here." className="py-8" />}
        {inProgress.length > 0 && <Group title="In Progress" tasks={inProgress} />}
        {recent.length > 0 && <Group title="Recent" tasks={recent} />}
      </div>
      {recent.length > 0 && (
        <div className="flex justify-end border-t border-separator px-3 py-2">
          <Button
            size="sm"
            onClick={() => queryClient.setQueryData<TaskSnapshot[]>(['tasks'], (l) => l?.filter((t) => active(t.state) || t.state === 'failed'))}
          >
            Clear Completed
          </Button>
        </div>
      )}
    </div>
  )
}

function Group({ title, tasks }: { title: string; tasks: TaskSnapshot[] }) {
  return (
    <section aria-label={title} className="mb-1">
      <h3 className="px-2 pt-1 pb-1 text-small font-semibold text-label-3">{title}</h3>
      <ul className="flex flex-col gap-1">
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
  const bytes =
    task.bytesTotal !== undefined ? `${formatBytes(task.bytesDone ?? 0)} of ${formatBytes(task.bytesTotal)}${task.state === 'paused' ? ' · Paused' : eta(task.etaMs) ? ` · ${eta(task.etaMs)}` : ''}` : undefined

  return (
    <li className="rounded-lg px-2 py-2 hover:bg-fill">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-4',
            task.state === 'failed' ? 'bg-[color-mix(in_srgb,var(--color-red)_14%,transparent)] text-red' : 'bg-accent-soft text-accent',
          )}
        >
          {kindIcon[task.kind]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <p className="truncate text-body font-medium">{task.title}</p>
            {task.children.length > 0 && (
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? 'Hide steps' : 'Show steps'}
                onClick={() => setExpanded((e) => !e)}
                className="flex size-4 shrink-0 items-center justify-center rounded text-label-3 hover:text-label-2"
              >
                <ChevronRight className={cn('size-3 transition-transform duration-150', expanded && 'rotate-90')} strokeWidth={2.5} />
              </button>
            )}
          </div>
          {task.subtitle && isActive && <p className="truncate text-small text-label-2">{task.subtitle}</p>}
          {isActive && <ProgressBar value={task.progress} label={task.title} className="mt-1.5" tone={task.state === 'paused' ? 'label' : 'accent'} />}
          {isActive && bytes && <p className="mt-1 text-small text-label-2 tabular">{bytes}</p>}
          {task.state === 'succeeded' && task.finishedAt && <p className="text-small text-label-2">Finished {formatRelative(task.finishedAt)}</p>}
          {task.state === 'failed' && task.error && (
            <div className="mt-0.5">
              <p className="text-small text-red">{task.error.message}</p>
              <div className="mt-1.5 flex gap-2">
                <Button size="sm" onClick={() => patchTask(task.id, { state: 'running', progress: 0, error: undefined })}>
                  Retry
                </Button>
                <Button
                  size="sm"
                  variant="borderless"
                  onClick={() => {
                    navigator.clipboard?.writeText(`${task.title}\n${task.error?.message}\n${task.error?.details}`)
                    toast({ kind: 'success', title: 'Copied details' })
                  }}
                >
                  Copy Details
                </Button>
              </div>
            </div>
          )}
          {expanded && (
            <ul className="mt-2 flex flex-col gap-1 border-l border-separator pl-2.5">
              {task.children.map((c) => (
                <li key={c.id} className="flex items-center gap-1.5 text-small text-label-2">
                  {c.state === 'running' ? <ProgressRing value={c.progress} size={12} stroke={1.75} /> : stateIcon[c.state]}
                  <span className="truncate">{c.title}</span>
                  {c.progress !== undefined && c.state === 'running' && <span className="ml-auto tabular">{Math.round(c.progress * 100)}%</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        {isActive && (
          <div className="flex shrink-0 items-center">
            {/* TODO(wire): api.tasks.pause(id) / api.tasks.resume(id) / api.tasks.cancel(id) */}
            <IconButton
              label={task.state === 'paused' ? 'Resume' : 'Pause'}
              size="sm"
              onClick={() => patchTask(task.id, { state: task.state === 'paused' ? 'running' : 'paused' })}
            >
              {task.state === 'paused' ? <Play /> : <Pause />}
            </IconButton>
            <IconButton label="Cancel" size="sm" onClick={() => patchTask(task.id, { state: 'cancelled', finishedAt: Date.now() })}>
              <X />
            </IconButton>
          </div>
        )}
        {!isActive && task.state !== 'failed' && <span className="mt-1">{stateIcon[task.state]}</span>}
      </div>
    </li>
  )
}
