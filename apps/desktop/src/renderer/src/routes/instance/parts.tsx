import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useParams } from '@tanstack/react-router'
import { Check, Copy } from 'lucide-react'
import { Badge, IconButton, toast, cn, type SortState, type Column } from '@/ui'
import type { Source } from '@/data/types'
import { useUi } from '@/app/ui-store'

/** The `$instanceId` route param of the instance detail routes. */
export function useInstanceId(): string {
  return (useParams({ strict: false }) as { instanceId?: string }).instanceId ?? ''
}

/** A slim row of tab-specific controls under the tab strip. */
export function SubToolbar({ children, trailing }: { children?: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-separator px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {trailing && <div className="flex shrink-0 items-center gap-1.5">{trailing}</div>}
    </div>
  )
}

/** A content tab body: the main pane plus the optional trailing inspector (⌥⌘I). */
export function SplitView({ children, inspector, inspectorLabel }: { children: ReactNode; inspector?: ReactNode; inspectorLabel: string }) {
  const visible = useUi((s) => s.inspector)
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      {visible && inspector && (
        <aside aria-label={inspectorLabel} className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-separator bg-window-2/60">
          {inspector}
        </aside>
      )}
    </div>
  )
}

export function InspectorHeader({ icon, title, subtitle }: { icon: ReactNode; title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 pt-4 pb-3">
      {icon}
      <div className="min-w-0">
        <h2 className="text-title3 leading-5 font-semibold break-words">{title}</h2>
        {subtitle && <p className="mt-0.5 text-small text-label-2">{subtitle}</p>}
      </div>
    </div>
  )
}

export function InspectorSection({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('border-t border-separator px-4 py-3', className)}>
      {title && <h3 className="mb-1.5 text-small font-semibold text-label-2">{title}</h3>}
      {children}
    </section>
  )
}

/** A label/value list for inspectors. */
export function PropertyList({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-callout">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-label-2">{r.label}</dt>
          <dd className="min-w-0 text-right break-words text-label">{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Copies text, with a toast confirming it. */
export function copyText(text: string, what = 'Copied') {
  navigator.clipboard?.writeText(text)
  toast({ kind: 'success', title: what })
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <IconButton
      label={label}
      size="sm"
      onClick={() => {
        navigator.clipboard?.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check /> : <Copy />}
    </IconButton>
  )
}

export function SourceBadge({ source }: { source: Source }) {
  if (source === 'modrinth') return <Badge tone="success">Modrinth</Badge>
  if (source === 'curseforge') return <Badge tone="warning">CurseForge</Badge>
  return <Badge>Local</Badge>
}

/** Client-side sorting for a VirtualTable's rows. */
export function useSorted<T>(rows: readonly T[], columns: Column<T>[], initial: SortState = null) {
  const [sort, setSort] = useState<SortState>(initial)
  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.id === sort.column)
    if (!sort || !col?.sortValue) return rows
    const dir = sort.direction === 'asc' ? 1 : -1
    const get = col.sortValue
    return rows.toSorted((a, b) => {
      const x = get(a)
      const y = get(b)
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir
    })
  }, [rows, columns, sort])
  return { sorted, sort, setSort }
}

/** Single-selection convenience on top of the table's set-based selection. */
export function useSelection() {
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const only = selection.size === 1 ? [...selection][0] : undefined
  const clear = useCallback(() => setSelection(new Set()), [])
  return { selection, setSelection, only, clear }
}

export const sideLabel = { client: 'Client', server: 'Server', both: 'Both' } as const
