import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, Compass, CornerDownLeft, LayoutPanelTop, Search, Settings2, Sparkles } from 'lucide-react'
import { PanelDialog, Switch, cn, shortcutGlyphs } from '@/ui'
import { useInstanceActions, useInstances } from '@/data/instances'
import { useAppSettings, useSettings } from '@/data/settings'
import type { InstanceSummary } from '@/data/types'
import { router } from './router'
import { currentInstanceId, openInstance, openSettings, runCommand } from './commands'
import { applyToggle } from './settings-index'
import { buildPaletteItems, searchPalette, type PaletteAction, type PaletteItem, type PaletteResult } from './palette-items'
import { useUi } from './ui-store'
import { BlockIcon } from './visuals'

const NO_INSTANCES: InstanceSummary[] = []

/** ⌘K: Spotlight-style command palette over routes, instances, actions and settings (B12). */
export function CommandPalette() {
  const open = useUi((s) => s.palette)
  const set = useUi((s) => s.set)
  return (
    <PanelDialog open={open} onOpenChange={(o) => set({ palette: o })} title="Command Palette">
      {open && <PaletteBody onClose={() => set({ palette: false })} />}
    </PanelDialog>
  )
}

export function PaletteBody({ onClose, instancesOverride }: { onClose: () => void; instancesOverride?: InstanceSummary[] }) {
  const { data } = useInstances()
  const instances = instancesOverride ?? data ?? NO_INSTANCES
  const view = useSettings()
  const app = useAppSettings()
  const settings = useMemo(() => ({ app, view }), [app, view])
  const actions = useInstanceActions()
  const [query, setQuery] = useState('')
  const [stack, setStack] = useState<PaletteItem[]>([])
  const [active, setActive] = useState(0)
  // Space toggles a setting only after the user has moved onto it with the arrow keys; while typing, it's a space.
  const [navigated, setNavigated] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()

  const ctx = useMemo(() => ({ instances, currentInstanceId: currentInstanceId(), settings }), [instances, settings])
  const items = useMemo(() => buildPaletteItems(ctx), [ctx])
  const parent = stack[stack.length - 1]
  const results: PaletteResult[] = useMemo(() => {
    if (parent) {
      const kids = parent.children ?? []
      const q = query.trim().toLowerCase()
      return kids.filter((k) => !q || k.title.toLowerCase().includes(q)).map((item) => ({ item }))
    }
    return searchPalette(items, query, ctx)
  }, [items, query, ctx, parent])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const perform = (a: PaletteAction) => {
    onClose()
    switch (a.kind) {
      case 'command':
        return runCommand(a.command, a.arg)
      case 'open-instance':
        return openInstance(a.id, a.tab ?? 'overview')
      case 'launch': {
        const inst = instances.find((i) => i.id === a.id)
        if (inst) actions.launch(inst)
        return
      }
      case 'settings':
        return openSettings(a.pane, a.row)
      case 'discover':
        return void router.navigate({ to: '/discover', search: { q: a.query } })
      case 'navigate':
        return void router.navigate({ to: a.to, search: a.to === '/discover' ? {} : undefined })
    }
  }

  const popStack = () => {
    setStack((s) => s.slice(0, -1))
    setQuery('')
    setActive(0)
  }

  const drill = (item: PaletteItem | undefined) => {
    if (!item?.children) return false
    setStack((s) => [...s, item])
    setQuery('')
    setActive(0)
    return true
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const cur = results[active]?.item
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setNavigated(true)
      setActive((a) => Math.min(results.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setNavigated(true)
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!cur) return
      if (e.metaKey && cur.secondary) perform(cur.secondary)
      else perform(cur.run)
    } else if ((e.key === 'ArrowRight' && (e.currentTarget as HTMLInputElement).selectionStart === query.length) || (e.key === 'Tab' && !e.shiftKey)) {
      if (drill(cur)) e.preventDefault()
      else if (e.key === 'Tab') e.preventDefault()
    } else if ((e.key === 'ArrowLeft' && query === '') || (e.key === 'Tab' && e.shiftKey)) {
      if (stack.length) {
        e.preventDefault()
        popStack()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (stack.length) popStack()
      else onClose()
    } else if (e.key === ' ' && cur?.toggle && navigated) {
      e.preventDefault()
      applyToggle(cur.toggle.action)
    } else if (e.metaKey && /^[1-9]$/.test(e.key)) {
      const pick = results[Number(e.key) - 1]
      if (pick) {
        e.preventDefault()
        perform(pick.item.run)
      }
    }
  }

  const headers = results.map((r, i) => !parent && r.item.group !== results[i - 1]?.item.group)
  return (
    <div className="flex flex-col">
      <div className="flex h-[52px] items-center gap-2.5 px-4">
        {parent ? (
          <button
            type="button"
            onClick={() => popStack()}
            className="flex items-center gap-1 rounded-md bg-fill-2 py-0.5 pr-2 pl-1 text-callout font-medium text-label"
          >
            <ChevronLeft className="size-3.5" /> {parent.title}
          </button>
        ) : (
          <Search aria-hidden className="size-5 text-label-2" />
        )}
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-activedescendant={results[active] ? `${id}-${active}` : undefined}
          aria-label="Search commands, instances and settings"
          placeholder={parent ? `Actions for ${parent.title}` : 'Search instances, actions and settings'}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
            setNavigated(false)
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          className="h-full flex-1 bg-transparent text-title2 text-label outline-none placeholder:text-label-3"
        />
      </div>
      <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="Results" className="max-h-[min(420px,56vh)] overflow-y-auto border-t border-separator p-1.5">
        {results.length === 0 && <p className="px-3 py-6 text-center text-body text-label-2">No results for “{query}”</p>}
        {results.map((r, i) => {
          return (
            <Fragment key={`${r.item.group}:${r.item.id}`}>
              {headers[i] && <div className="px-2.5 pt-2 pb-1 text-small font-semibold text-label-3">{r.item.group}</div>}
              <div
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                onMouseMove={() => setActive(i)}
                onClick={() => perform(r.item.run)}
                className={cn('group flex h-9 items-center gap-2.5 rounded-lg px-2.5', i === active && 'bg-accent-fill text-on-accent')}
              >
                <ItemIcon item={r.item} active={i === active} />
                <span className="min-w-0 flex-1 truncate text-body">
                  <Highlight text={r.item.title} indices={r.match?.indices} />
                  {r.item.subtitle && <span className={cn('ml-2 text-small', i === active ? 'text-on-accent/70' : 'text-label-2')}>{r.item.subtitle}</span>}
                </span>
                {r.item.toggle && (
                  <span onClick={(e) => e.stopPropagation()}>
                    <Switch size="sm" checked={r.item.toggle.on} onCheckedChange={() => applyToggle(r.item.toggle!.action)} aria-label={r.item.title} />
                  </span>
                )}
                {r.item.shortcut && <span className={cn('text-callout tracking-[0.08em]', i === active ? 'text-on-accent/75' : 'text-label-3')}>{shortcutGlyphs(r.item.shortcut)}</span>}
                {r.item.children && <ChevronRight className={cn('size-3.5', i === active ? 'text-on-accent/80' : 'text-label-3')} />}
                {!r.item.shortcut && i < 9 && i === active && <span className="text-callout text-on-accent/75">{shortcutGlyphs(`mod+${i + 1}`)}</span>}
              </div>
            </Fragment>
          )
        })}
      </div>
      <div className="flex items-center gap-4 border-t border-separator px-4 py-2 text-small text-label-2">
        <Hint keys={<CornerDownLeft className="size-3" />}>Open</Hint>
        <Hint keys="⌘↩">Launch</Hint>
        <Hint keys={<ArrowRight className="size-3" />}>Actions</Hint>
        <Hint keys="⎋">{stack.length ? 'Back' : 'Close'}</Hint>
      </div>
    </div>
  )
}

function Hint({ keys, children }: { keys: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-fill-2 px-1 font-sans text-caption text-label-2">{keys}</kbd>
      {children}
    </span>
  )
}

function ItemIcon({ item, active }: { item: PaletteItem; active: boolean }) {
  if (item.icon.kind === 'instance') return <BlockIcon hue={item.icon.hue} label={item.icon.name} size={20} />
  const glyph = { action: <Sparkles />, nav: <Compass />, settings: <Settings2 />, search: <Search />, tab: <LayoutPanelTop /> }[item.icon.name]
  return <span className={cn('flex size-5 items-center justify-center [&_svg]:size-4', active ? 'text-on-accent' : 'text-label-2')}>{glyph}</span>
}

function Highlight({ text, indices }: { text: string; indices?: number[] }) {
  if (!indices?.length) return <>{text}</>
  const set = new Set(indices)
  return (
    <>
      {[...text].map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="font-semibold">
            {ch}
          </span>
        ) : (
          <Fragment key={i}>{ch}</Fragment>
        ),
      )}
    </>
  )
}
