import { useEffect } from 'react'
import { CatchBoundary, Outlet, useRouterState } from '@tanstack/react-router'
import { subscribe } from '@/lib/rpc'
import { ToastViewport, cn } from '@/ui'
import { AppSidebar } from './AppSidebar'
import { BackgroundLayer } from './BackgroundLayer'
import { GlobalSurfaces } from './GlobalSurfaces'
import { RouteError } from './RouteStates'
import { runCommand } from './commands'
import { useUi } from './ui-store'

/** The main window: vibrancy sidebar + opaque content area + window-wide surfaces (B1). */
export function Shell() {
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // Native menu bar → the same command dispatcher the palette uses.
  useEffect(() => subscribe('menu:command', ({ command, arg }) => runCommand(command, arg)), [])

  return (
    <div className="flex h-full">
      {!collapsed && <AppSidebar />}
      <main
        className={cn(
          'relative isolate flex min-w-0 flex-1 flex-col bg-window',
          !collapsed && 'shadow-[-0.5px_0_0_var(--color-separator),-1px_0_0_light-dark(rgb(0_0_0/0.04),rgb(0_0_0/0.5))]',
        )}
      >
        <BackgroundLayer />
        {/* Errors are contained per view; the sidebar and toolbar keep working. */}
        <CatchBoundary getResetKey={() => pathname} errorComponent={RouteError}>
          <Outlet />
        </CatchBoundary>
        <ToastViewport />
      </main>
      <GlobalSurfaces />
    </div>
  )
}
