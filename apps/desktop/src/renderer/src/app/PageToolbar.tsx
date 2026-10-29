import type { ReactNode } from 'react'
import { PanelLeft, Search } from 'lucide-react'
import { IconButton, Toolbar } from '@/ui'
import { ActivityButton } from './Activity'
import { useUi } from './ui-store'

/**
 * The content-area toolbar every page uses: page actions (`trailing`), the Activity button, then
 * `end` (overflow menu and the page's primary action, e.g. Play), like the mockup. The Search
 * button (⌘K) lives in the sidebar, so it only appears here while the sidebar is hidden, which is
 * also when the toolbar makes room for the traffic lights.
 */
export function PageToolbar({
  leading,
  center,
  trailing,
  end,
  separator,
}: {
  leading?: ReactNode
  center?: ReactNode
  trailing?: ReactNode
  end?: ReactNode
  separator?: boolean
}) {
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const set = useUi((s) => s.set)
  return (
    <Toolbar
      separator={separator}
      className={collapsed ? '!pl-[84px]' : undefined}
      leading={
        <>
          {collapsed && (
            <IconButton label="Show Sidebar" shortcut="ctrl+mod+s" onClick={() => set({ sidebarCollapsed: false })}>
              <PanelLeft />
            </IconButton>
          )}
          {leading}
        </>
      }
      center={center}
      trailing={
        <>
          {trailing}
          <ActivityButton />
          {collapsed && (
            <IconButton label="Search" shortcut="mod+k" onClick={() => set({ palette: true })}>
              <Search />
            </IconButton>
          )}
          {end}
        </>
      }
    />
  )
}
