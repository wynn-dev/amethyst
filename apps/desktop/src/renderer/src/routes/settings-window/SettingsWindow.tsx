import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, Outlet, useParams, useSearch } from '@tanstack/react-router'
import { Coffee, Gamepad2, Globe, Hand, Info, Palette, RefreshCw, Settings, UserRound, Wrench } from 'lucide-react'
import { SearchField, SourceList, SourceListItem, ToastViewport, Toolbar, ToolbarTitle } from '@/ui'
import { subscribe } from '@/lib/rpc'
import { SETTINGS_INDEX, SETTINGS_PANES, type SettingsPaneId } from '@/app/settings-index'
import { useUi } from '@/app/ui-store'
import { useSettings } from '@/data/settings'
import { SettingsSearchContext, matchesQuery } from './context'

const AddAccountSheet = lazy(() => import('@/routes/sheets/AddAccountSheet'))

/** System Settings-style glyph tiles for each pane. */
export const PANE_ICONS: Record<SettingsPaneId, { icon: ReactNode; color: string }> = {
  general: { icon: <Settings />, color: '#8e8e93' },
  accounts: { icon: <UserRound />, color: '#007aff' },
  appearance: { icon: <Palette />, color: '#1c1c1e' },
  java: { icon: <Coffee />, color: '#ff9500' },
  game: { icon: <Gamepad2 />, color: '#34c759' },
  network: { icon: <Globe />, color: '#0a84ff' },
  privacy: { icon: <Hand />, color: '#5856d6' },
  updates: { icon: <RefreshCw />, color: '#8e8e93' },
  advanced: { icon: <Wrench />, color: '#636366' },
  about: { icon: <Info />, color: '#8b55d6' },
}

export function PaneGlyph({ pane, size = 20 }: { pane: SettingsPaneId; size?: number }) {
  const { icon, color } = PANE_ICONS[pane]
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-[5px] text-white shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.12),inset_0_0.5px_0_rgb(255_255_255/0.25)] [&_svg]:size-[62%]"
      style={{ width: size, height: size, background: `linear-gradient(180deg, color-mix(in srgb, ${color} 82%, white), ${color})` }}
    >
      {icon}
    </span>
  )
}

/**
 * The Settings window (B7): a separate BrowserWindow loading `#/settings/<pane>`. Translucent
 * sidebar with search and panes; opaque content with a draggable toolbar showing the pane title.
 */
export function SettingsWindow() {
  const { pane } = useParams({ strict: false }) as { pane?: string }
  const { row } = useSearch({ strict: false }) as { row?: string }
  const translucent = useSettings().translucentSidebar
  const addAccount = useUi((s) => s.addAccount)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

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
        <aside aria-label="Settings sidebar" className={translucent ? 'flex w-[215px] shrink-0 flex-col bg-transparent' : 'flex w-[215px] shrink-0 flex-col bg-window-2'}>
          <div className="drag h-[52px] shrink-0" />
          <div className="shrink-0 px-2.5 pb-2.5">
            <SearchField ref={searchRef} value={query} onValueChange={setQuery} placeholder="Search" label="Search settings" />
          </div>
          <SourceList aria-label="Settings panes" className="min-h-0 flex-1 overflow-y-auto pb-3">
            <div role="list" className="flex flex-col gap-px">
              {panes.map((p) => (
                <SourceListItem
                  key={p.id}
                  icon={<PaneGlyph pane={p.id} />}
                  label={p.title}
                  selected={p.id === pane}
                  trailing={query.trim() && p.hits > 0 ? <span className="text-small text-label-3 tabular">{p.hits}</span> : undefined}
                  render={(props) => <Link to="/settings/$pane" params={{ pane: p.id }} {...props} />}
                />
              ))}
              {panes.length === 0 && <p className="px-2.5 py-2 text-small text-label-3">No results for “{query.trim()}”</p>}
            </div>
          </SourceList>
        </aside>
        <main className="relative flex min-w-0 flex-1 flex-col bg-window shadow-[-0.5px_0_0_var(--color-separator)]">
          <Toolbar leading={<ToolbarTitle title={title} />} />
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-8">
            <Outlet />
          </div>
          <ToastViewport />
        </main>
      </div>
      <Suspense fallback={null}>{addAccount && <AddAccountSheet />}</Suspense>
    </SettingsSearchContext.Provider>
  )
}
