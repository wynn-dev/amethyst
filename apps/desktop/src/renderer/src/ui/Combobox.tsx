import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Popover } from 'radix-ui'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from './cn'
import { fieldClass } from './TextField'
import { menuSurface } from './Menu'

export interface ComboboxOption {
  value: string
  label: string
  /** Secondary text on the right, e.g. a date. */
  detail?: string
  /** Small tags, e.g. Recommended / Latest. */
  tags?: ReactNode
  disabled?: boolean
}

export interface ComboboxProps {
  value: string | undefined
  onValueChange: (value: string) => void
  options: ComboboxOption[]
  'aria-label': string
  placeholder?: string
  emptyText?: string
  className?: string
  disabled?: boolean
  /** Custom matcher. Defaults to a case-insensitive substring match on the label. */
  filter?: (option: ComboboxOption, query: string) => boolean
}

const ROW = 24
const labelFilter = (o: ComboboxOption, q: string) => o.label.toLowerCase().includes(q.toLowerCase())

/**
 * Searchable pop-up list (ARIA combobox + listbox). Results are virtualised, so it handles
 * thousands of versions. The chosen value is never cleared when the query filters it out.
 */
export function Combobox({
  value,
  onValueChange,
  options,
  placeholder,
  emptyText = 'No matches',
  className,
  disabled,
  filter = labelFilter,
  ...aria
}: ComboboxProps) {
  const id = useId()
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)

  const results = useMemo(() => (query ? options.filter((o) => filter(o, query)) : options), [options, query, filter])

  // eslint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 8,
  })

  // On open, start from the selected option.
  useEffect(() => {
    if (!open) return
    const i = Math.max(0, results.findIndex((o) => o.value === value))
    setActive(i)
    requestAnimationFrame(() => virtualizer.scrollToIndex(i, { align: 'center' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const commit = (o: ComboboxOption | undefined) => {
    if (!o || o.disabled) return
    onValueChange(o.value)
    setQuery(null)
    setOpen(false)
  }

  const move = (d: number) => {
    if (!results.length) return
    const next = (active + d + results.length) % results.length
    setActive(next)
    virtualizer.scrollToIndex(next)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className={cn('relative', className)}>
          <input
            role="combobox"
            aria-label={aria['aria-label']}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && results[active] ? `${id}-${active}` : undefined}
            disabled={disabled}
            placeholder={placeholder}
            spellCheck={false}
            value={query ?? selected?.label ?? ''}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
              setOpen(true)
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setQuery(null)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                if (!open) setOpen(true)
                else move(1)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                move(-1)
              } else if (e.key === 'Enter' && open) {
                e.preventDefault()
                commit(results[active])
              } else if (e.key === 'Escape' && open) {
                e.preventDefault()
                setOpen(false)
                setQuery(null)
              }
            }}
            className={cn(fieldClass, 'h-[22px] pr-6 pl-[7px]')}
          />
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((o) => !o)}
            className="absolute top-[3px] right-[3px] flex size-4 items-center justify-center rounded-[4px] bg-accent-fill text-on-accent"
          >
            <ChevronDown className="size-3" strokeWidth={2.5} />
          </button>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if ((e.target as HTMLElement).closest?.('[role=combobox]')) e.preventDefault()
          }}
          className={cn(menuSurface, 'w-(--radix-popover-trigger-width) p-0')}
        >
          <div ref={scrollRef} id={listId} role="listbox" aria-label={aria['aria-label']} className="max-h-[264px] overflow-y-auto p-[5px]">
            {results.length === 0 ? (
              <div className="px-2.5 py-1.5 text-label-2">{emptyText}</div>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((row) => {
                  const o = results[row.index]!
                  return (
                    <div
                      key={o.value}
                      id={`${id}-${row.index}`}
                      role="option"
                      aria-selected={o.value === value}
                      aria-disabled={o.disabled}
                      data-active={row.index === active || undefined}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => setActive(row.index)}
                      onClick={() => commit(o)}
                      style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW, transform: `translateY(${row.start}px)` }}
                      className={cn(
                        'group flex items-center gap-2 rounded-[4px] pr-2.5 pl-[22px] text-body',
                        'data-[active]:bg-accent-fill data-[active]:text-on-accent aria-disabled:text-label-3',
                      )}
                    >
                      {o.value === value && <Check className="absolute left-1.5 size-3.5" strokeWidth={2.5} />}
                      <span className="truncate">{o.label}</span>
                      {o.tags}
                      {o.detail && <span className="ml-auto shrink-0 text-small text-label-2 group-data-[active]:text-on-accent/80">{o.detail}</span>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
