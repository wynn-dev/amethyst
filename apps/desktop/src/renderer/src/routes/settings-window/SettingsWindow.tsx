import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, Outlet, useParams, useSearch } from '@tanstack/react-router'
import { Coffee, Gamepad2, Globe, Hand, Info, Palette, RefreshCw, Settings, UserRound, Wrench } from 'lucide-react'
import { SearchField, SourceList, SourceListItem, ToastViewport, Toolbar, ToolbarTitle, indicatorClass, useSlidingIndicator } from '@/ui'
import { subscribe } from '@/lib/rpc'
import { SETTINGS_INDEX, SETTINGS_PANES, type SettingsPaneId } from '@/app/settings-index'
import { useUi } from '@/app/ui-store'
import { useAppearance } from '@/data/appearance'
import { SettingsSearchContext, matchesQuery } from './context'

const AddAccountSheet = lazy(() => import('@/routes/sheets/AddAccountSheet'))

/** A plain line icon per pane: muted, and the label colour when selected (the source list does that). */
export const PANE_ICONS: Record<SettingsPaneId, ReactNode> = {
  general: <Settings strokeWidth={1.5} />,
  accounts: <UserRound strokeWidth={1.5} />,
  appearance: <Palette strokeWidth={1.5} />,
  java: <Coffee strokeWidth={1.5} />,
  game: <Gamepad2 strokeWidth={1.5} />,
  network: <Globe strokeWidth={1.5} />,
  privacy: <Hand strokeWidth={1.5} />,
  updates: <RefreshCw strokeWidth={1.5} />,
  advanced: <Wrench strokeWidth={1.5} />,
  about: <Info strokeWidth={1.5} />,
}

/**
 * The Settings window (B7): a separate BrowserWindow loading `#/settings/<pane>`. Translucent
 * sidebar with search and panes; opaque content with a draggable toolbar showing the pane title.
 */
export function SettingsWindow() {
  const { pane } = useParams({ strict: false }) as { pane?: string }
  const { row } = useSearch({ strict: false }) as { row?: string }
  const translucent = useAppearance().vibrancy
  const addAccount = useUi((s) => s.addAccount)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const indicator = useSlidingIndicator(list, '.sl-row[aria-current="page"]', `${pane}:${query}`)

  // ⌘F from the menu bar focuses the settings search.
  useEffect(
    () =>
      subscribe('menu:command', ({ command }) => {
        if (command === 'edit.find') searchRef.current?.focus()
      }),
    [],
  )

  const panes = useMemo(() => {
    if (!query.trim()) return SETTINGS_PANES.map((p) => ({ ...p, hits: 0 }))
    return SETTINGS_PANES.map((p) => ({
      ...p,
      hits: SETTINGS_INDEX.filter((r) => r.pane === p.id && matchesQuery(r.title, r.keywords, query)).length,
      self: matchesQuery(p.title, undefined, query),
    })).filter((p) => p.hits > 0 || p.self)
  }, [query])

  const title = SETTINGS_PANES.find((p) => p.id === pane)?.title ?? 'Settings'
  const context = useMemo(() => ({ query, row }), [query, row])

  return (
    <SettingsSearchContext.Provider value={context}>
      <div className="flex h-full">
        <aside
          aria-label="Settings sidebar"
          className={translucent ? 'flex w-[200px] shrink-0 flex-col bg-transparent' : 'flex w-[200px] shrink-0 flex-col bg-window-2'}
        >
          <div className="drag h-[46px] shrink-0" />
          <div className="shrink-0 px-2.5 pb-2">
            <SearchField ref={searchRef} value={query} onValueChange={setQuery} placeholder="Search" label="Search settings" />
          </div>
          <SourceList aria-label="Settings panes" indicator className="min-h-0 flex-1 overflow-y-auto pb-3">
            <div ref={list} role="list" className="relative flex flex-col gap-px">
              <span ref={indicator} aria-hidden className={indicatorClass} />
              {panes.map((p) => (
                <SourceListItem
                  key={p.id}
                  icon={PANE_ICONS[p.id]}
                  label={p.title}
                  selected={p.id === pane}
                  trailing={query.trim() && p.hits > 0 ? <span className="font-mono text-[10.5px] text-label-3 tabular">{p.hits}</span> : undefined}
                  render={(props) => <Link to="/settings/$pane" params={{ pane: p.id }} {...props} />}
                />
              ))}
              {panes.length === 0 && <p className="px-2 py-2 text-meta text-label-3">No results for “{query.trim()}”</p>}
            </div>
          </SourceList>
        </aside>
        <main className="relative flex min-w-0 flex-1 flex-col bg-window shadow-[-0.5px_0_0_var(--color-separator)]">
          <Toolbar leading={<ToolbarTitle title={title} />} />
          <div key={pane} className="min-h-0 flex-1 animate-enter overflow-y-auto px-4 pt-3.5 pb-6">
            <Outlet />
          </div>
          <ToastViewport />
        </main>
      </div>
      <Suspense fallback={null}>{addAccount && <AddAccountSheet />}</Suspense>
    </SettingsSearchContext.Provider>
  )
}
