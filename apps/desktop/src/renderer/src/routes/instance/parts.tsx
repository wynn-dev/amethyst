import { useCallback, useId, useMemo, useState, type ReactNode } from 'react'
import { useParams } from '@tanstack/react-router'
import { Check, Copy } from 'lucide-react'
import { IconButton, InstanceArt, toast, cn, type SortState, type Column } from '@/ui'
import type { ResourceRow } from '@shared/services'
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

export const SOURCE_LABEL: Record<Source, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge', local: 'Local' }

/** Where a file came from, as plain muted text (no coloured pill). */
export function SourceBadge({ source }: { source: Source }) {
  return <span className="text-label-2">{SOURCE_LABEL[source]}</span>
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

/* ------------------------------------------------------------------------------------------ */
/* Cards (the mockup's `.card`, `.row` and `.stats`)                                          */
/* ------------------------------------------------------------------------------------------ */

/**
 * A hairline-bordered card: a 32px header row (title, then a muted mono count or a trailing
 * action) over rows separated by hairlines. No fill, no shadow.
 */
export function Card({ title, count, action, children, className }: { title: string; count?: number | string; action?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={cn('min-w-0 overflow-hidden rounded-[10px] border border-separator', className)}>
      <header className="flex h-8 items-center gap-2 border-b border-separator px-3">
        <h2 id={id} className="min-w-0 flex-1 truncate text-meta font-semibold text-label-2">
          {title}
        </h2>
        {count !== undefined && <span className="font-mono text-[10.5px] text-label-3 tabular">{count}</span>}
        {action}
      </header>
      <div className="flex flex-col divide-y divide-separator">{children}</div>
    </section>
  )
}

/** Shared by every card row: 34px (46px when `tall`), 12px sides, 12.5px text. */
export const cardRowClass = (tall?: boolean) => cn('flex items-center gap-2.5 px-3 text-compact', tall ? 'min-h-[46px] py-1.5' : 'min-h-[34px] py-1')

/** A plain card row. */
export function CardRow({ children, tall, className }: { children: ReactNode; tall?: boolean; className?: string }) {
  return <div className={cn(cardRowClass(tall), className)}>{children}</div>
}

/** A key/value card row: a muted 76px key, the value, then optional muted trailing text. */
export function KeyValueRow({ label, children, trailing, className }: { label: string; children: ReactNode; trailing?: ReactNode; className?: string }) {
  return (
    <div className={cn(cardRowClass(), className)}>
      <span className="w-[76px] shrink-0 text-meta text-label-2">{label}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing !== undefined && <span className="shrink-0 text-meta whitespace-nowrap text-label-2">{trailing}</span>}
    </div>
  )
}

/** Two lines in a row: a medium-weight title and a muted, truncated subtitle. */
export function RowText({ title, subtitle, className }: { title: ReactNode; subtitle?: ReactNode; className?: string }) {
  return (
    <span className={cn('flex min-w-0 flex-1 flex-col leading-[1.25]', className)}>
      <span className="truncate font-medium">{title}</span>
      {subtitle && <span className="truncate text-meta text-label-2">{subtitle}</span>}
    </span>
  )
}

export interface StatItem {
  label: string
  /** The number, in plain tabular figures. */
  value: ReactNode
  /** A small muted unit after the number ("h", "GB"). */
  unit?: string
  onClick?: () => void
}

/** A strip of figures in hairline cells (Played, Mods, Worlds…). Cells with `onClick` are buttons. */
export function StatStrip({ items, label }: { items: StatItem[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="grid auto-cols-fr grid-flow-col overflow-hidden rounded-[10px] border border-separator">
      {items.map((s) => {
        const body = (
          <>
            <span className="flex h-[21px] items-baseline gap-[3px] text-[19px] leading-[21px] font-medium tracking-[-0.02em] tabular">
              {s.value}
              {s.unit && <span className="text-meta font-normal tracking-normal text-label-2">{s.unit}</span>}
            </span>
            <span className="text-meta text-label-2">{s.label}</span>
          </>
        )
        const cell = 'flex min-w-0 flex-col items-start gap-[9px] px-3.5 pt-3 pb-[11px] border-l border-separator text-left first:border-l-0'
        return s.onClick ? (
          <button key={s.label} type="button" onClick={s.onClick} className={cn(cell, 'outline-none first:rounded-l-[9px] last:rounded-r-[9px] hover:bg-hover focus-visible:bg-hover focus-visible:shadow-[inset_0_0_0_1.5px_var(--focus-ring)]')}>
            {body}
          </button>
        ) : (
          <div key={s.label} className={cell}>
            {body}
          </div>
        )
      })}
    </div>
  )
}

/** A world's icon as a small landscape thumbnail (the mockup's `.thumb`); generated art when it has none. */
export function WorldThumb({ world, className }: { world: Pick<ResourceRow, 'id' | 'iconUrl'>; className?: string }) {
  return (
    <span className={cn('relative block h-[30px] w-[52px] shrink-0 overflow-hidden rounded-[5px]', className)}>
      {world.iconUrl ? (
        <img src={world.iconUrl} alt="" loading="lazy" decoding="async" className="block size-full object-cover [image-rendering:pixelated]" />
      ) : (
        <span className="absolute top-1/2 left-0 flex -translate-y-1/2">
          <InstanceArt seed={hashSeed(world.id)} size={52} />
        </span>
      )}
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_0.5px_light-dark(rgb(0_0_0/0.1),rgb(255_255_255/0.12))]" />
    </span>
  )
}

function hashSeed(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}
