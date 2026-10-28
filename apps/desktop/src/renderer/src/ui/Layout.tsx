import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Collapsible, Tabs as RTabs } from 'radix-ui'
import { ChevronRight } from 'lucide-react'
import { cn } from './cn'
import { useSlidingIndicator } from './motion'

/** The grey selection pill that slides between items (tabs, sidebar rows). */
export const indicatorClass =
  'pointer-events-none absolute top-0 left-0 rounded-md bg-selection opacity-0 transition-[transform,width,height,opacity] ease-spring duration-(--duration-spring)'

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
 * The toolbar row (48 px, centred on the traffic lights). Empty space drags the window;
 * interactive descendants are excluded from the drag region automatically.
 */
export function Toolbar({ leading, center, trailing, className, separator = true }: ToolbarProps) {
  return (
    <header
      className={cn(
        'drag relative flex h-12 shrink-0 items-center gap-1.5 pr-2.5 pl-4',
        separator && 'shadow-[inset_0_-1px_0_var(--color-separator)]',
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
    <div className="flex min-w-0 items-center gap-2.5">
      {icon}
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate text-headline font-semibold text-label">{title}</h1>
        {subtitle && <p className="truncate text-meta text-label-2 tabular">{subtitle}</p>}
      </div>
    </div>
  )
}

export function ToolbarDivider() {
  return <span aria-hidden className="mx-1 h-4 w-px bg-separator" />
}

/* ------------------------------------------------------------------------------------------ */
/* Tab strip                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface TabStripItem<V extends string> {
  value: V
  label: ReactNode
  /** A count shown after the label in small monospaced figures. */
  count?: number
}

export interface TabStripProps<V extends string> {
  value: V
  onValueChange: (value: V) => void
  items: TabStripItem<V>[]
  'aria-label': string
  className?: string
}

/**
 * A row of tabs whose selection pill slides between them, for views whose panels are routes
 * (the tab buttons switch the route). ARIA tabs with roving focus: ←/→, Home and End move and
 * select.
 */
export function TabStrip<V extends string>({ value, onValueChange, items, className, ...aria }: TabStripProps<V>) {
  const list = useRef<HTMLDivElement>(null)
  const indicator = useSlidingIndicator(list, '[aria-selected="true"]', value)
  const onKeyDown = (e: KeyboardEvent) => {
    const i = items.findIndex((t) => t.value === value)
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }[e.key]
    if (next === undefined) return
    e.preventDefault()
    const item = items[(next + items.length) % items.length]!
    onValueChange(item.value)
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-value="${item.value}"]`)?.focus())
  }
  return (
    <div ref={list} role="tablist" aria-label={aria['aria-label']} onKeyDown={onKeyDown} className={cn('relative flex items-center gap-0.5', className)}>
      <span ref={indicator} aria-hidden className={indicatorClass} />
      {items.map((t) => {
        const selected = t.value === value
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            data-value={t.value}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(t.value)}
            className={cn(
              'relative flex h-[26px] items-center gap-1.5 rounded-md px-2.5 text-compact whitespace-nowrap outline-none transition-colors duration-150',
              'focus-visible:shadow-[inset_0_0_0_1.5px_var(--focus-ring)]',
              selected ? 'text-label' : 'text-label-2 hover:text-label',
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="font-mono text-[10.5px] text-label-3 tabular">{t.count}</span>}
          </button>
        )
      })}
    </div>
  )
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

/** Tab view with a tab strip whose selection pill slides (Radix Tabs: arrow keys, roving focus). */
export function Tabs<V extends string>({ value, onValueChange, tabs, className, listClassName, ...aria }: TabsProps<V>) {
  const list = useRef<HTMLDivElement>(null)
  const indicator = useSlidingIndicator(list, '[data-state="active"]', value)
  return (
    <RTabs.Root value={value} onValueChange={(v) => onValueChange(v as V)} className={cn('flex min-h-0 flex-col', className)}>
      <RTabs.List ref={list} aria-label={aria['aria-label']} className={cn('relative inline-flex items-center gap-0.5', listClassName)}>
        <span ref={indicator} aria-hidden className={indicatorClass} />
        {tabs.map((t) => (
          <RTabs.Trigger
            key={t.value}
            value={t.value}
            className="relative flex h-[26px] items-center rounded-md px-2.5 text-compact whitespace-nowrap text-label-2 outline-none transition-colors duration-150 hover:text-label data-[state=active]:text-label focus-visible:shadow-[inset_0_0_0_1.5px_var(--focus-ring)]"
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

/**
 * A vibrancy source list. Rows use `SourceListItem`; groups use `SourceListSection`. Set
 * `indicator` when the list draws its own sliding selection pill (rows then stay unfilled).
 */
export function SourceList({ children, className, indicator, 'aria-label': label }: { children: ReactNode; className?: string; indicator?: boolean; 'aria-label': string }) {
  return (
    <nav aria-label={label} data-indicator={indicator || undefined} className={cn('source-list flex flex-col gap-3 px-2', className)}>
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
        <div className="flex h-7 items-center justify-between pr-0.5 pl-2">
          <h2 className="text-small font-semibold text-label-3">{title}</h2>
          <div className="flex items-center gap-0.5">
            {action}
            {collapsible && (
              <Collapsible.Trigger
                aria-label={open ? `Hide ${title}` : `Show ${title}`}
                className="flex size-5 items-center justify-center rounded-[4px] text-label-3 opacity-0 group-hover/section:opacity-100 hover:text-label-2 focus-visible:opacity-100"
              >
                <ChevronRight className={cn('size-3 transition-transform duration-150', open && 'rotate-90')} strokeWidth={2} />
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
  /** Right-aligned detail in small monospaced figures, e.g. a version. */
  detail?: ReactNode
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
 * A source-list row (26 px; taller with a secondary line). Selection is a grey pill; icons are
 * muted until selected. The row element is supplied by `render` so routes can use real links.
 */
export function SourceListItem({ icon, label, secondary, detail, trailing, selected, progress, indent = 0, className, listItem = true, render }: SourceListItemProps) {
  const children = (
    <>
      {icon && <span className={cn('flex shrink-0 items-center justify-center [&>svg]:size-[15px]', selected ? 'text-label' : 'text-label-2')}>{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate leading-4">{label}</span>
        {secondary && <span className="truncate text-small leading-[13px] text-label-2">{secondary}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-1">{trailing}</span>}
      {detail !== undefined && <span className="shrink-0 font-mono text-[10.5px] text-label-3 tabular">{detail}</span>}
      {progress !== undefined && (
        <span aria-hidden className="absolute right-2 bottom-[1px] left-2 h-[2px] overflow-hidden rounded-full bg-fill">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${progress * 100}%` }} />
        </span>
      )}
    </>
  )
  return (
    <div role={listItem ? 'listitem' : undefined} className="relative" style={indent ? { paddingLeft: indent * 14 } : undefined}>
      {render({
        className: cn(
          'sl-row relative flex w-full items-center gap-2 rounded-md px-2 text-left text-body text-label outline-none hover:bg-hover aria-[current=page]:hover:bg-transparent',
          secondary ? 'min-h-[38px] py-1' : 'h-[26px]',
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
    <div className="group/section flex h-7 items-center justify-between pr-0.5 pl-2">
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
            <ChevronRight className={cn('size-3 transition-transform duration-150', open && 'rotate-90')} strokeWidth={2} />
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
      className="sl-row flex h-[26px] w-full items-center gap-1.5 rounded-md px-2 text-left text-body text-label outline-none hover:bg-hover"
    >
      <ChevronRight className={cn('-ml-0.5 size-3 shrink-0 text-label-3 transition-transform duration-150', open && 'rotate-90')} strokeWidth={2} />
      {icon && <span className="flex shrink-0 text-label-2 [&>svg]:size-[15px]">{icon}</span>}
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="ml-auto font-mono text-[10.5px] text-label-3 tabular">{count}</span>}
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
      <Collapsible.Trigger className="sl-row flex h-[26px] w-full items-center gap-1.5 rounded-md px-2 text-left text-body text-label outline-none hover:bg-hover">
        <ChevronRight className={cn('-ml-0.5 size-3 shrink-0 text-label-3 transition-transform duration-150', open && 'rotate-90')} strokeWidth={2} />
        {icon && <span className="flex shrink-0 text-label-2 [&>svg]:size-[15px]">{icon}</span>}
        <span className="truncate">{label}</span>
        {count !== undefined && <span className="ml-auto font-mono text-[10.5px] text-label-3 tabular">{count}</span>}
      </Collapsible.Trigger>
      <Collapsible.Content role="list" className="flex flex-col gap-px">
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
