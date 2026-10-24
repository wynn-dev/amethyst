import type { ReactNode } from 'react'
import { PanelLeft, Search } from 'lucide-react'
import { IconButton, Toolbar, ToolbarDivider } from '@/ui'
import { ActivityButton } from './Activity'
import { useUi } from './ui-store'

/**
 * The content-area toolbar every page uses. The Activity and Search buttons are always on the
 * trailing edge (B1). When the sidebar is hidden, it makes room for the traffic lights.
 */
export function PageToolbar({ leading, center, trailing, separator }: { leading?: ReactNode; center?: ReactNode; trailing?: ReactNode; separator?: boolean }) {
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
          {trailing && <ToolbarDivider />}
          <ActivityButton />
          <IconButton label="Search" shortcut="mod+k" onClick={() => set({ palette: true })}>
            <Search />
          </IconButton>
        </>
      }
    />
  )
}
