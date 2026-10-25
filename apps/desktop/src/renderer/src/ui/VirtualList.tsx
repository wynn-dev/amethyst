import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { useVirtualizer, type Rect } from '@tanstack/react-virtual'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from './cn'
import { ContextMenu, type MenuEntry } from './Menu'

/* ------------------------------------------------------------------------------------------ */
/* Selection model, shared by lists and tables                                                */
/* ------------------------------------------------------------------------------------------ */

export type Selection = ReadonlySet<string>

export interface SelectionHandlers {
  /** Applies a click with macOS modifiers: plain, ⌘ (toggle), ⇧ (range from the anchor). */
  click(index: number, e: { metaKey: boolean; shiftKey: boolean }): void
  /** Moves the active row by `delta`, extending the selection with ⇧. */
  move(delta: number, extend: boolean): void
  selectAll(): void
}

/**
 * Pure selection reducer used by VirtualTable (exported for tests). `keys` are the selectable
 * row keys in display order; `null` entries (group headers) are skipped by keyboard movement.
 */
export function nextSelection(
  keys: (string | null)[],
  current: Selection,
  anchor: number,
  index: number,
  mode: 'replace' | 'toggle' | 'range',
): Set<string> {
  const key = keys[index]
  if (key == null) return new Set(current)
  if (mode === 'toggle') {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }
  if (mode === 'range') {
    const [a, b] = anchor <= index ? [anchor, index] : [index, anchor]
    const next = new Set<string>()
    for (let i = Math.max(0, a); i <= b; i++) {
      const k = keys[i]
      if (k != null) next.add(k)
    }
    return next
  }
  return new Set([key])
}

/* ------------------------------------------------------------------------------------------ */
/* VirtualList                                                                                */
/* ------------------------------------------------------------------------------------------ */

export interface VirtualListHandle {
  scrollToIndex(index: number, align?: 'start' | 'center' | 'end' | 'auto'): void
  scrollToBottom(): void
}

export interface VirtualListProps<T> {
  items: readonly T[]
  /** Row height in px, fixed or per row kind. Known heights mean no measuring and no layout thrash. */
  rowHeight: number | ((item: T, index: number) => number)
  getKey: (item: T, index: number) => string
  renderRow: (item: T, index: number) => ReactNode
  'aria-label': string
  className?: string
  overscan?: number
  /** Keep the view pinned to the last row while the user is at the bottom (logs). */
  followTail?: boolean
  /** Fires when the "at bottom" state changes. */
  onAtBottomChange?: (atBottom: boolean) => void
  /** Content rendered above the rows inside the scroller. */
  header?: ReactNode
  /** Padding inside the scroller, in px. */
  paddingY?: number
  role?: 'list' | 'log' | 'listbox'
  ref?: Ref<VirtualListHandle>
  /** Initial viewport size; lets tests and SSR render rows before layout. */
  initialRect?: Rect
}

/** Generic windowed list. Only the rows in view (plus overscan) are in the DOM. */
export function VirtualList<T>({
  items,
  rowHeight,
  getKey,
  renderRow,
  className,
  overscan = 10,
  followTail,
  onAtBottomChange,
  header,
  paddingY = 0,
  role = 'list',
  ref,
  initialRect,
  ...aria
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const heightOf = (i: number) => (typeof rowHeight === 'number' ? rowHeight : rowHeight(items[i]!, i))
  // TanStack Virtual is required here (performance.md V2); it opts this component out of compiler memoisation.
  // eslint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: heightOf,
    overscan,
    paddingStart: paddingY,
    paddingEnd: paddingY,
    getItemKey: (i) => getKey(items[i]!, i),
    initialRect,
  })

  useImperativeHandle(ref, () => ({
    scrollToIndex: (i, align = 'auto') => virtualizer.scrollToIndex(i, { align }),
    scrollToBottom: () => {
      if (items.length) virtualizer.scrollToIndex(items.length - 1, { align: 'end' })
    },
  }))

  // Follow the tail: when rows are appended and we were at the bottom, stay there.
  useLayoutEffect(() => {
    if (followTail && atBottom.current && items.length) virtualizer.scrollToIndex(items.length - 1, { align: 'end' })
  }, [followTail, items.length, virtualizer])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (bottom !== atBottom.current) {
      atBottom.current = bottom
      onAtBottomChange?.(bottom)
    }
  }, [onAtBottomChange])

  return (
    <div ref={scrollRef} onScroll={onScroll} className={cn('relative min-h-0 overflow-y-auto contain-strict', className)}>
      {header}
      <div role={role} aria-label={aria['aria-label']} style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            role={role === 'listbox' ? undefined : 'listitem'}
            data-index={row.index}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: row.size, transform: `translateY(${row.start}px)` }}
          >
            {renderRow(items[row.index]!, row.index)}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* VirtualTable                                                                               */
/* ------------------------------------------------------------------------------------------ */

export interface Column<T> {
  id: string
  header: ReactNode
  /** Plain-text header for menus and accessibility. */
  title: string
  /** CSS width, e.g. `120px` or `minmax(160px,1fr)`. */
  width: string
  align?: 'start' | 'end' | 'center'
  cell: (row: T) => ReactNode
  /** Return a comparable value to make the column sortable. */
  sortValue?: (row: T) => string | number
  /** Users can hide this column from the header context menu. */
  hideable?: boolean
}

export type SortState = { column: string; direction: 'asc' | 'desc' } | null

export interface VirtualTableProps<T> {
  rows: readonly T[]
  columns: Column<T>[]
  getKey: (row: T) => string
  'aria-label': string
  /** Controlled selection. */
  selection?: Selection
  onSelectionChange?: (selection: Set<string>) => void
  /** Return a header label to render the row as a non-selectable section header. */
  groupHeader?: (row: T) => ReactNode | null
  /** Return / double-click. */
  onActivate?: (row: T) => void
  /** Space: e.g. toggle enabled for the selection. */
  onToggle?: (keys: string[]) => void
  /** ⌫ / Delete: e.g. move the selection to the Trash (after confirmation). */
  onDelete?: (keys: string[]) => void
  /** Context menu for the clicked row (or the selection that contains it). */
  rowMenu?: (keys: string[]) => MenuEntry[]
  sort?: SortState
  onSortChange?: (sort: SortState) => void
  hiddenColumns?: ReadonlySet<string>
  onHiddenColumnsChange?: (hidden: Set<string>) => void
  rowHeight?: number
  className?: string
  /** Extra per-row classes, e.g. dimming disabled rows. */
  rowClassName?: (row: T) => string | undefined
  initialRect?: Rect
  ref?: Ref<VirtualListHandle>
}

const HEADER_HEIGHT = 26

/**
 * A native-feeling table: sticky sortable header, alternating rows, macOS selection semantics
 * (click, ⌘-click, ⇧-click, ⌘A, arrows, Home/End), Space/Return/Delete hooks, a column
 * visibility menu on the header, and row context menus. Rows are virtualised.
 */
export function VirtualTable<T>({
  rows,
  columns,
  getKey,
  selection = EMPTY,
  onSelectionChange,
  groupHeader,
  onActivate,
  onToggle,
  onDelete,
  rowMenu,
  sort,
  onSortChange,
  hiddenColumns = EMPTY,
  onHiddenColumnsChange,
  rowHeight = 28,
  className,
  rowClassName,
  initialRect,
  ref,
  ...aria
}: VirtualTableProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(-1)
  const anchor = useRef(0)
  const visible = columns.filter((c) => !hiddenColumns.has(c.id))
  const template = visible.map((c) => c.width).join(' ')
  const keys = rows.map((r) => (groupHeader?.(r) != null ? null : getKey(r)))

  // eslint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    paddingStart: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    getItemKey: (i) => keys[i] ?? `header:${i}`,
    initialRect,
  })

  useImperativeHandle(ref, () => ({
    scrollToIndex: (i, align = 'auto') => virtualizer.scrollToIndex(i, { align }),
    scrollToBottom: () => rows.length && virtualizer.scrollToIndex(rows.length - 1, { align: 'end' }),
  }))

  // Keep the active row valid when rows change.
  useEffect(() => {
    if (active >= rows.length) setActive(rows.length - 1)
  }, [rows.length, active])

  const select = (index: number, mode: 'replace' | 'toggle' | 'range') => {
    if (!onSelectionChange || keys[index] == null) return
    onSelectionChange(nextSelection(keys, selection, anchor.current, index, mode))
    if (mode !== 'range') anchor.current = index
    setActive(index)
  }

  const step = (from: number, delta: number) => {
    let i = from
    do i += delta
    while (i >= 0 && i < keys.length && keys[i] == null)
    return i < 0 || i >= keys.length ? from : i
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const selected = [...selection]
    const go = (i: number) => {
      e.preventDefault()
      select(i, e.shiftKey ? 'range' : 'replace')
      virtualizer.scrollToIndex(i)
    }
    switch (e.key) {
      case 'ArrowDown':
        return go(step(active, 1))
      case 'ArrowUp':
        return go(active < 0 ? step(-1, 1) : step(active, -1))
      case 'Home':
        return go(step(-1, 1))
      case 'End':
        return go(step(keys.length, -1))
      case 'Enter': {
        const row = rows[active]
        if (row && onActivate) {
          e.preventDefault()
          onActivate(row)
        }
        return
      }
      case ' ':
        if (onToggle && selected.length) {
          e.preventDefault()
          onToggle(selected)
        }
        return
      case 'Backspace':
      case 'Delete':
        if (onDelete && selected.length && (e.metaKey || e.key === 'Delete')) {
          e.preventDefault()
          onDelete(selected)
        }
        return
      case 'a':
        if (e.metaKey && onSelectionChange) {
          e.preventDefault()
          onSelectionChange(new Set(keys.filter((k): k is string => k != null)))
        }
        return
      case 'Escape':
        if (selection.size && onSelectionChange) {
          e.preventDefault()
          onSelectionChange(new Set())
        }
    }
  }

  const onRowMouseDown = (index: number, e: MouseEvent) => {
    if (e.button === 2) {
      // Right-click on an unselected row selects it first, like Finder.
      const key = keys[index]
      if (key != null && !selection.has(key)) select(index, 'replace')
      return
    }
    if (e.button !== 0) return
    select(index, e.shiftKey ? 'range' : e.metaKey ? 'toggle' : 'replace')
  }

  const headerMenu: MenuEntry[] = [
    { kind: 'label', label: 'Columns' },
    ...columns
      .filter((c) => c.hideable)
      .map<MenuEntry>((c) => ({
        kind: 'check',
        label: c.title,
        checked: !hiddenColumns.has(c.id),
        onCheckedChange: (on) => {
          const next = new Set(hiddenColumns)
          if (on) next.delete(c.id)
          else next.add(c.id)
          onHiddenColumnsChange?.(next)
        },
      })),
  ]

  const header = (
    <div
      role="row"
      aria-rowindex={1}
      className="sticky top-0 z-10 grid items-center border-b border-separator bg-window/90 backdrop-blur-xl"
      style={{ gridTemplateColumns: template, height: HEADER_HEIGHT }}
    >
      {visible.map((c, i) => {
        const sorted = sort?.column === c.id ? sort.direction : undefined
        const content = (
          <span className={cn('flex min-w-0 items-center gap-1', c.align === 'end' && 'justify-end', c.align === 'center' && 'justify-center')}>
            <span className="truncate">{c.header}</span>
            {sorted && (sorted === 'asc' ? <ChevronUp className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />)}
          </span>
        )
        return (
          <div
            key={c.id}
            role="columnheader"
            aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : c.sortValue ? 'none' : undefined}
            className={cn('h-full min-w-0 text-small font-medium text-label-2', i > 0 && 'border-l border-separator')}
          >
            {c.sortValue && onSortChange ? (
              <button
                type="button"
                tabIndex={-1}
                onClick={() =>
                  onSortChange(sorted === 'asc' ? { column: c.id, direction: 'desc' } : sorted === 'desc' ? null : { column: c.id, direction: 'asc' })
                }
                className="flex h-full w-full items-center px-2 hover:bg-fill"
              >
                {content}
              </button>
            ) : (
              <div className="flex h-full items-center px-2">{content}</div>
            )}
          </div>
        )
      })}
    </div>
  )

  const activeKey = keys[active]

  return (
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-label={aria['aria-label']}
      aria-rowcount={rows.length + 1}
      aria-colcount={visible.length}
      aria-multiselectable={onSelectionChange ? true : undefined}
      aria-activedescendant={activeKey ? rowId(activeKey) : undefined}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (active < 0 && rows.length) setActive(step(-1, 1))
      }}
      className={cn('group/table relative min-h-0 overflow-auto outline-none contain-strict', className)}
    >
      {onHiddenColumnsChange && columns.some((c) => c.hideable) ? <ContextMenu items={headerMenu}>{header}</ContextMenu> : header}
      <div role="rowgroup" style={{ height: virtualizer.getTotalSize() - HEADER_HEIGHT, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index]!
          const label = groupHeader?.(row)
          const style = {
            position: 'absolute' as const,
            top: 0,
            left: 0,
            width: '100%',
            height: rowHeight,
            transform: `translateY(${v.start - HEADER_HEIGHT}px)`,
          }
          if (label != null) {
            return (
              <div key={v.key} role="row" aria-rowindex={v.index + 2} style={style} className="flex items-end border-b border-separator px-2 pb-1">
                <div role="gridcell" aria-colspan={visible.length} className="text-small font-semibold text-label-2">
                  {label}
                </div>
              </div>
            )
          }
          const key = keys[v.index]!
          const rowEl = (
            <TableRow
              key={v.key}
              id={rowId(key)}
              index={v.index}
              style={style}
              template={template}
              columns={visible}
              row={row}
              selected={selection.has(key)}
              active={v.index === active}
              striped={v.index % 2 === 1}
              className={rowClassName?.(row)}
              onMouseDown={onRowMouseDown}
              onDoubleClick={onActivate}
            />
          )
          return rowMenu ? (
            <ContextMenu key={v.key} items={() => rowMenu(selection.has(key) ? [...selection] : [key])}>
              {rowEl}
            </ContextMenu>
          ) : (
            rowEl
          )
        })}
      </div>
    </div>
  )
}

const EMPTY: ReadonlySet<string> = new Set()
const rowId = (key: string) => `row-${key.replace(/[^\w-]/g, '_')}`

interface TableRowProps<T> {
  id: string
  index: number
  style: React.CSSProperties
  template: string
  columns: Column<T>[]
  row: T
  selected: boolean
  active: boolean
  striped: boolean
  className?: string
  onMouseDown: (index: number, e: MouseEvent) => void
  onDoubleClick?: (row: T) => void
}

// Memoised on row identity and selection, so scrolling and selection changes re-render only the rows that changed.
const TableRow = memo(function TableRow<T>({
  id,
  index,
  style,
  template,
  columns,
  row,
  selected,
  active,
  striped,
  className,
  onMouseDown,
  onDoubleClick,
  ...rest
}: TableRowProps<T>) {
  return (
    <div
      {...rest}
      id={id}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      data-active={active || undefined}
      onMouseDown={(e) => onMouseDown(index, e)}
      onDoubleClick={() => onDoubleClick?.(row)}
      style={{ ...style, gridTemplateColumns: template }}
      className={cn(
        'grid items-center text-body',
        striped && 'bg-row-alt',
        selected && 'bg-selection group-focus/table:bg-accent-fill group-focus/table:text-on-accent',
        className,
      )}
    >
      {columns.map((c) => (
        <div
          key={c.id}
          role="gridcell"
          className={cn('flex min-w-0 items-center px-2', c.align === 'end' && 'justify-end tabular', c.align === 'center' && 'justify-center')}
        >
          {c.cell(row)}
        </div>
      ))}
    </div>
  )
}) as <T>(props: TableRowProps<T>) => ReactNode
