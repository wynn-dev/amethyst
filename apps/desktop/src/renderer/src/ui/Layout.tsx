import { useState, type ReactNode } from 'react'
import { Collapsible, Tabs as RTabs } from 'radix-ui'
import { ChevronRight } from 'lucide-react'
import { cn } from './cn'

/* ------------------------------------------------------------------------------------------ */
/* Toolbar                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface ToolbarProps {
  /** Leading content: title, breadcrumb, back button. */
  leading?: ReactNode
  /** Centered content, e.g. a segmented control. */
  center?: ReactNode
  /** Trailing actions. */
  trailing?: ReactNode
  className?: string
  /** Draw the hairline under the toolbar (when content scrolls under it). */
  separator?: boolean
}

/**
 * The unified toolbar row (52 px). Empty space drags the window; interactive descendants are
 * excluded from the drag region automatically.
 */
export function Toolbar({ leading, center, trailing, className, separator = true }: ToolbarProps) {
  return (
    <header
      className={cn(
        'drag relative flex h-[52px] shrink-0 items-center gap-2 px-3',
        separator && 'shadow-[0_0.5px_0_var(--color-separator)]',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{leading}</div>
      {center && <div className="flex shrink-0 items-center">{center}</div>}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">{trailing}</div>
    </header>
  )
}

export function ToolbarTitle({ title, subtitle, icon }: { title: ReactNode; subtitle?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 pl-1">
      {icon}
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate text-title3 leading-[18px] font-semibold text-label">{title}</h1>
        {subtitle && <p className="truncate text-small text-label-2">{subtitle}</p>}
      </div>
    </div>
  )
}

export function ToolbarDivider() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-separator" />
}

/* ------------------------------------------------------------------------------------------ */
/* Tabs                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export interface TabSpec<V extends string> {
  value: V
  label: ReactNode
  content: ReactNode
}

export interface TabsProps<V extends string> {
  value: V
  onValueChange: (value: V) => void
  tabs: TabSpec<V>[]
  'aria-label': string
  className?: string
  listClassName?: string
}

/** Tab view with a centered segmented-style tab strip (Radix Tabs: arrow keys, roving focus). */
export function Tabs<V extends string>({ value, onValueChange, tabs, className, listClassName, ...aria }: TabsProps<V>) {
  return (
    <RTabs.Root value={value} onValueChange={(v) => onValueChange(v as V)} className={cn('flex min-h-0 flex-col', className)}>
      <RTabs.List aria-label={aria['aria-label']} className={cn('mx-auto inline-flex items-center rounded-[7px] bg-fill p-[2px]', listClassName)}>
        {tabs.map((t) => (
          <RTabs.Trigger
            key={t.value}
            value={t.value}
            className="flex h-[22px] items-center rounded-[5px] px-3 text-body whitespace-nowrap text-label outline-none data-[state=active]:bg-control data-[state=active]:font-medium data-[state=active]:shadow-control focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,var(--accent)_55%,transparent)]"
          >
            {t.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {tabs.map((t) => (
        <RTabs.Content key={t.value} value={t.value} className="min-h-0 flex-1 outline-none">
          {t.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Sidebar / source list                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** A vibrancy source list. Rows use `SourceListItem`; groups use `SourceListSection`. */
export function SourceList({ children, className, 'aria-label': label }: { children: ReactNode; className?: string; 'aria-label': string }) {
  return (
    <nav aria-label={label} className={cn('source-list flex flex-col gap-3 px-2.5', className)}>
      {children}
    </nav>
  )
}

export interface SourceListSectionProps {
  title?: string
  /** Trailing header action, e.g. a "+" button. */
  action?: ReactNode
  children: ReactNode
  /** Sections can be hidden with the disclosure that appears on hover/focus, like Finder. */
  collapsible?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function SourceListSection({ title, action, children, collapsible = true, open: openProp, onOpenChange }: SourceListSectionProps) {
  const [openState, setOpenState] = useState(true)
  const open = openProp ?? openState
  const setOpen = onOpenChange ?? setOpenState
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="group/section flex flex-col">
      {title && (
        <div className="flex h-[26px] items-center justify-between pr-1 pl-2.5">
          <h2 className="text-small font-semibold text-label-3">{title}</h2>
          <div className="flex items-center gap-0.5">
            {action}
            {collapsible && (
              <Collapsible.Trigger
                aria-label={open ? `Hide ${title}` : `Show ${title}`}
                className="flex size-5 items-center justify-center rounded-[4px] text-label-3 opacity-0 group-hover/section:opacity-100 hover:text-label-2 focus-visible:opacity-100"
              >
                <ChevronRight className={cn('size-3 transition-transform duration-150', open && 'rotate-90')} strokeWidth={2.5} />
              </Collapsible.Trigger>
            )}
          </div>
        </div>
      )}
      <Collapsible.Content role="list" className="flex flex-col gap-px">
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

export interface SourceListItemProps {
  icon?: ReactNode
  label: ReactNode
  /** Secondary line, e.g. "1.21.1 · Fabric". */
  secondary?: ReactNode
  /** Trailing state: spinner, dot, badge, count. */
  trailing?: ReactNode
  selected?: boolean
  /** Thin progress bar along the bottom edge (0–1). */
  progress?: number
  indent?: number
  className?: string
  /** Wrap in role=listitem (default). Off when the container already provides list items. */
  listItem?: boolean
  /** Rendered element: pass a router <Link> via `render`. */
  render: (props: { className: string; 'aria-current'?: 'page'; children: ReactNode }) => ReactNode
}

/**
 * A source-list row. Selection is grey, and turns accent while the sidebar has keyboard focus,
 * like Finder. The row element is supplied by `render` so routes can use real links.
 */
export function SourceListItem({ icon, label, secondary, trailing, selected, progress, indent = 0, className, listItem = true, render }: SourceListItemProps) {
  const children = (
    <>
      {icon && <span className="flex shrink-0 items-center justify-center text-accent">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body leading-4">{label}</span>
        {secondary && <span className="truncate text-small leading-[13px] text-label-2">{secondary}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-1">{trailing}</span>}
      {progress !== undefined && (
        <span aria-hidden className="absolute right-2 bottom-[2px] left-2 h-[2px] overflow-hidden rounded-full bg-fill-2">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${progress * 100}%` }} />
        </span>
      )}
    </>
  )
  return (
    <div role={listItem ? 'listitem' : undefined} className="relative" style={indent ? { paddingLeft: indent * 14 } : undefined}>
      {render({
        className: cn(
          'sl-row relative flex w-full items-center gap-2 rounded-[6px] px-2 text-left text-label outline-none hover:bg-fill',
          secondary ? 'min-h-[38px] py-1' : 'h-7',
          className,
        ),
        'aria-current': selected ? 'page' : undefined,
        children,
      })}
    </div>
  )
}

/**
 * Flat building blocks for long, virtualised source lists, where sections and folders are rows
 * rather than wrappers: a section header and a disclosure row.
 */
export function SourceListHeader({
  title,
  action,
  open,
  onOpenChange,
}: {
  title: string
  action?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <div className="group/section flex h-[26px] items-center justify-between pr-1 pl-2.5">
      <h2 className="text-small font-semibold text-label-3">{title}</h2>
      <div className="flex items-center gap-0.5">
        {action}
        {onOpenChange && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `Hide ${title}` : `Show ${title}`}
            onClick={() => onOpenChange(!open)}
            className="flex size-5 items-center justify-center rounded-[4px] text-label-3 opacity-0 group-hover/section:opacity-100 hover:text-label-2 focus-visible:opacity-100"
          >
            <ChevronRight className={cn('size-3 transition-transform duration-150', open && 'rotate-90')} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  )
}

export function SourceListDisclosure({
  label,
  open,
  onOpenChange,
  icon,
  count,
}: {
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  icon?: ReactNode
  count?: number
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' && !open) onOpenChange(true)
        if (e.key === 'ArrowLeft' && open) onOpenChange(false)
      }}
      className="sl-row flex h-7 w-full items-center gap-1.5 rounded-[6px] px-2 text-left text-body text-label outline-none hover:bg-fill"
    >
      <ChevronRight className={cn('-ml-0.5 size-3 shrink-0 text-label-3 transition-transform duration-150', open && 'rotate-90')} strokeWidth={2.5} />
      {icon && <span className="flex shrink-0 text-accent">{icon}</span>}
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="ml-auto text-small text-label-3 tabular">{count}</span>}
    </button>
  )
}

export interface SourceListFolderProps {
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  icon?: ReactNode
  count?: number
  children: ReactNode
}

/** A disclosure group inside a source list (instance folders). */
export function SourceListFolder({ label, open, onOpenChange, icon, count, children }: SourceListFolderProps) {
  return (
    <Collapsible.Root open={open} onOpenChange={onOpenChange} role="listitem">
      <Collapsible.Trigger className="sl-row flex h-7 w-full items-center gap-1.5 rounded-[6px] px-2 text-left text-body text-label outline-none hover:bg-fill">
        <ChevronRight className={cn('-ml-0.5 size-3 shrink-0 text-label-3 transition-transform duration-150', open && 'rotate-90')} strokeWidth={2.5} />
        {icon && <span className="flex shrink-0 text-accent">{icon}</span>}
        <span className="truncate">{label}</span>
        {count !== undefined && <span className="ml-auto text-small text-label-3 tabular">{count}</span>}
      </Collapsible.Trigger>
      <Collapsible.Content role="list" className="flex flex-col gap-px">
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
