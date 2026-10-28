import { useId, useState, type ReactNode } from 'react'
import { ChevronRight, RotateCcw } from 'lucide-react'
import { cn } from './cn'
import { IconButton } from './Button'

/** A page of grouped settings. */
export function Form({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto flex w-full max-w-[640px] flex-col gap-5', className)}>{children}</div>
}

export interface FormSectionProps {
  title?: string
  /** Text under the group. */
  footer?: ReactNode
  /** Trailing header content, e.g. a button. */
  action?: ReactNode
  children: ReactNode
  className?: string
  /** Render as a disclosure that starts collapsed. */
  collapsible?: boolean
  defaultOpen?: boolean
}

/** A hairline-bordered group of rows under a small muted header. */
export function FormSection({ title, footer, action, children, className, collapsible, defaultOpen = false }: FormSectionProps) {
  const id = useId()
  const [open, setOpen] = useState(!collapsible || defaultOpen)
  return (
    <section aria-labelledby={title ? id : undefined} className={cn('flex flex-col gap-1.5', className)}>
      {(title || action) && (
        <div className="flex min-h-5 items-end justify-between px-1">
          {title &&
            (collapsible ? (
              <button
                type="button"
                id={id}
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
                className="-ml-1 flex items-center gap-1 rounded-[4px] px-1 text-meta font-semibold text-label-2 hover:text-label"
              >
                <ChevronRight className={cn('size-3 text-label-3 transition-transform duration-150', open && 'rotate-90')} strokeWidth={2} />
                {title}
              </button>
            ) : (
              <h3 id={id} className="text-meta font-semibold text-label-2">
                {title}
              </h3>
            ))}
          {action}
        </div>
      )}
      {open && (
        <div className="divide-y divide-separator overflow-hidden rounded-xl border border-separator">{children}</div>
      )}
      {open && footer && <div className="px-1 text-meta text-label-2">{footer}</div>}
    </section>
  )
}

export interface FormRowProps {
  label: ReactNode
  description?: ReactNode
  /** The control. Rendered on the trailing side. */
  children?: ReactNode
  /** Id of the control, so clicking the label focuses it. */
  htmlFor?: string
  /** When set, the row is inheriting the global default and shows a grey "Default" note. */
  inherited?: boolean
  /** Shown when the row overrides a default; resets it. */
  onReset?: () => void
  /** Stack the control under the label (for wide controls like tables). */
  stacked?: boolean
  className?: string
  /** Highlight the row, e.g. when deep-linked from search. */
  highlighted?: boolean
  id?: string
}

/** One label/control row inside a FormSection. */
export function FormRow({ label, description, children, htmlFor, inherited, onReset, stacked, className, highlighted, id }: FormRowProps) {
  const Label = htmlFor ? 'label' : 'div'
  return (
    <div
      id={id}
      className={cn(
        'flex min-h-[38px] gap-3 px-3 py-[7px] transition-colors duration-500',
        stacked ? 'flex-col' : 'items-center justify-between',
        highlighted && 'bg-accent-soft',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col">
        <Label htmlFor={htmlFor} className="text-compact text-label">
          {label}
        </Label>
        {description && <div className="text-meta text-label-2">{description}</div>}
      </div>
      {(children || inherited || onReset) && (
        <div className={cn('flex shrink-0 items-center gap-2', stacked && 'w-full')}>
          {inherited && <span className="text-meta text-label-3">Default</span>}
          {!inherited && onReset && (
            <IconButton label="Reset to default" size="sm" onClick={onReset}>
              <RotateCcw />
            </IconButton>
          )}
          {children}
        </div>
      )}
    </div>
  )
}

/** Plain help text block for inside a FormSection. */
export function FormNote({ children }: { children: ReactNode }) {
  return <div className="px-3 py-2 text-meta text-label-2">{children}</div>
}
