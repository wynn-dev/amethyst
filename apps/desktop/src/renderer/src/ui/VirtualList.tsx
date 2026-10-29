import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
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

const HEADER_HEIGHT = 28

/**
 * A native-feeling table: sticky frosted sortable header, hairline-separated rows, macOS selection semantics
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
  rowHeight = 32,
  className,
  rowClassName,
  initialRect,
  ref,
  ...aria
}: VirtualTableProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(-1)
  const anchor = useRef(0)
  // Stable between scroll frames, so the memoised rows below only render when they change.
  const visible = useMemo(() => columns.filter((c) => !hiddenColumns.has(c.id)), [columns, hiddenColumns])
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

  const onRowMouseDown = useLatest((index: number, e: MouseEvent) => {
    if (e.button === 2) {
      // Right-click on an unselected row selects it first, like Finder.
      const key = keys[index]
      if (key != null && !selection.has(key)) select(index, 'replace')
      return
    }
    if (e.button !== 0) return
    select(index, e.shiftKey ? 'range' : e.metaKey ? 'toggle' : 'replace')
  })
  const onRowActivate = useLatest((row: T) => onActivate?.(row))
  const menuFor = useLatest((key: string) => rowMenu?.(selection.has(key) ? [...selection] : [key]) ?? [])

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

  // The frosted header is a deliberate design choice; it costs GPU memory while a long table is
  // scrolled (docs/PERFORMANCE.md, "What remains").
  const header = (
    <div
      role="row"
      aria-rowindex={1}
      className="sticky top-0 z-10 grid items-center border-b border-separator bg-window/72 backdrop-blur-[14px] backdrop-saturate-[1.6]"
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
            className={cn('h-full min-w-0 text-small text-label-3', i === 0 && 'pl-2')}
          >
            {c.sortValue && onSortChange ? (
              <button
                type="button"
                tabIndex={-1}
                onClick={() =>
                  onSortChange(sorted === 'asc' ? { column: c.id, direction: 'desc' } : sorted === 'desc' ? null : { column: c.id, direction: 'asc' })
                }
                className={cn('flex h-full w-full items-center px-2 hover:text-label-2', sorted && 'text-label-2')}
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
              <div key={v.key} role="row" aria-rowindex={v.index + 2} style={style} className="flex items-end border-b border-separator px-4 pb-1.5">
                <div role="gridcell" aria-colspan={visible.length} className="text-small font-semibold text-label-3">
                  {label}
                </div>
              </div>
            )
          }
          const key = keys[v.index]!
          return (
            <TableRow
              key={v.key}
              rowKey={key}
              index={v.index}
              top={v.start - HEADER_HEIGHT}
              height={rowHeight}
              template={template}
              columns={visible}
              row={row}
              selected={selection.has(key)}
              active={v.index === active}
              className={rowClassName?.(row)}
              onMouseDown={onRowMouseDown}
              onDoubleClick={onRowActivate}
              menu={rowMenu ? menuFor : undefined}
            />
          )
        })}
      </div>
    </div>
  )
}

const EMPTY: ReadonlySet<string> = new Set()
const rowId = (key: string) => `row-${key.replace(/[^\w-]/g, '_')}`

/** A callback with a stable identity that always runs the latest `fn` (keeps memoised rows memoised). */
function useLatest<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}

interface TableRowProps<T> {
  rowKey: string
  index: number
  /** Offset inside the row group and height, in px. */
  top: number
  height: number
  template: string
  columns: Column<T>[]
  row: T
  selected: boolean
  active: boolean
  className?: string
  onMouseDown: (index: number, e: MouseEvent) => void
  onDoubleClick: (row: T) => void
  /** The row's context menu entries (for the selection when the row is part of it). */
  menu?: (key: string) => MenuEntry[]
}

// Memoised on plain props (row identity, position, selection) and stable callbacks: while
// scrolling only the rows that enter the window render; the context menu lives inside the memo.
const TableRow = memo(function TableRow<T>({ rowKey, index, top, height, template, columns, row, selected, active, className, onMouseDown, onDoubleClick, menu }: TableRowProps<T>) {
  const el = (
    <div
      id={rowId(rowKey)}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      data-active={active || undefined}
      onMouseDown={(e) => onMouseDown(index, e)}
      onDoubleClick={() => onDoubleClick(row)}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height, transform: `translateY(${top}px)`, gridTemplateColumns: template }}
      className={cn(
        'grid items-center border-b border-separator text-compact',
        // Selection stays grey (a slightly firmer grey while the table has focus), never an accent slab.
        selected ? 'bg-selection group-focus/table:bg-fill-2' : 'hover:bg-hover',
        className,
      )}
    >
      {columns.map((c, i) => (
        <div
          key={c.id}
          role="gridcell"
          className={cn('flex min-w-0 items-center px-2', i === 0 && 'pl-4', c.align === 'end' && 'justify-end tabular', c.align === 'center' && 'justify-center')}
        >
          {c.cell(row)}
        </div>
      ))}
    </div>
  )
  return menu ? <ContextMenu items={() => menu(rowKey)}>{el}</ContextMenu> : el
}) as <T>(props: TableRowProps<T>) => ReactNode
