import { useId, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/ui'

/**
 * Building blocks for sheet bodies, after the mockup's `.card` and `.row`: hairline-bordered
 * cards with a 32 px header (title left, muted mono count or action right) and compact rows
 * separated by hairlines, labels on the left and controls on the right.
 */
export function Card({
  title,
  count,
  action,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode
  count?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  const id = useId()
  return (
    <section aria-labelledby={title ? id : undefined} className={cn('overflow-hidden rounded-[10px] border border-separator', className)}>
      {(title || action || count !== undefined) && <CardHeader id={id} title={title} count={count} action={action} />}
      <div className={cn('flex flex-col divide-y divide-separator', bodyClassName)}>{children}</div>
    </section>
  )
}

export function CardHeader({ id, title, count, action }: { id?: string; title?: ReactNode; count?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-separator pr-2 pl-3">
      <h3 id={id} className="truncate text-meta font-semibold text-label-2">
        {title}
      </h3>
      <div className="flex shrink-0 items-center gap-1.5">
        {count !== undefined && <span className="font-mono text-[10.5px] text-label-3 tabular">{count}</span>}
        {action}
      </div>
    </div>
  )
}

/**
 * A card whose body is hidden behind its header (e.g. "Advanced"). The header is the disclosure
 * button, named by its title.
 */
export function DisclosureCard({ title, open, onOpenChange, children }: { title: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[10px] border border-separator">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={cn(
          'flex h-8 w-full items-center gap-1.5 px-3 text-left text-meta font-semibold text-label-2 outline-none hover:text-label',
          'focus-visible:shadow-[inset_0_0_0_1.5px_var(--focus-ring)]',
          open && 'border-b border-separator',
        )}
      >
        <ChevronRight className={cn('size-3 text-label-3 transition-transform duration-(--duration-snappy) ease-snappy', open && 'rotate-90')} strokeWidth={2} />
        {title}
      </button>
      {open && <div className="flex animate-enter flex-col divide-y divide-separator">{children}</div>}
    </section>
  )
}

/** A label-left / control-right row (`.row` with a `.k` key column). */
export function Row({
  label,
  htmlFor,
  hint,
  hintId,
  children,
  className,
  tall,
}: {
  label: ReactNode
  htmlFor?: string
  /** Muted text under the control, e.g. why an option is disabled. */
  hint?: ReactNode
  /** Id for the hint, so the control can point `aria-describedby` at it. */
  hintId?: string
  children: ReactNode
  className?: string
  /** 46 px instead of 34 px, for rows with a second line. */
  tall?: boolean
}) {
  const Label = htmlFor ? 'label' : 'span'
  return (
    <div className={cn('flex gap-3 px-3 py-1', tall ? 'min-h-[46px]' : 'min-h-[38px]', hint ? 'items-start pt-[7px]' : 'items-center', className)}>
      <Label htmlFor={htmlFor} className={cn('w-[92px] shrink-0 text-meta text-label-2', !!hint && 'pt-[5px]')}>
        {label}
      </Label>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-h-[26px] min-w-0 items-center gap-2.5">{children}</div>
        {hint && (
          <div id={hintId} className="pb-1 text-meta text-label-2">
            {hint}
          </div>
        )}
      </div>
    </div>
  )
}

/** A read-only key / value row: muted key, value, and an optional muted trailing detail. */
export function InfoRow({ label, value, detail }: { label: ReactNode; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex min-h-[34px] items-center gap-3 px-3 text-compact">
      <span className="w-[92px] shrink-0 text-meta text-label-2">{label}</span>
      <span className="min-w-0 flex-1 truncate">{value}</span>
      {detail && <span className="shrink-0 text-meta text-label-2">{detail}</span>}
    </div>
  )
}

/** Muted help text between cards. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('px-0.5 text-meta text-label-2', className)}>{children}</p>
}

/** A loader version with its quiet "Recommended" / "Latest" notes (muted text, not badges). */
export function VersionLabel({ version, recommended, latest }: { version: string; recommended?: boolean; latest?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-meta">{version}</span>
      {recommended && <span className="text-meta text-label-3">Recommended</span>}
      {latest && <span className="text-meta text-label-3">Latest</span>}
    </span>
  )
}
