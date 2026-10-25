import { useEffect, useRef } from 'react'
import { CatchBoundary, Outlet, useRouterState } from '@tanstack/react-router'
import type { InstanceDetail as RuntimeDetail } from '@shared/services'
import { api, subscribe } from '@/lib/rpc'
import { ToastViewport, cn } from '@/ui'
import { toast } from '@/ui/toast-store'
import { reconcileFirstRun } from '@/data/firstRun'
import { getInstanceSummary, instanceKeys, useInstances } from '@/data/instances'
import { setLaunchEventHandler } from '@/data/launch'
import { queryClient } from '@/data/query'
import { settingsKey, useAppSettings, useSettingsLoaded, type AppSettings } from '@/data/settings'
import { installDockProgress, setTaskFinishedHandler, taskTitle } from '@/data/tasks'
import { updaterActions, useUpdaterState } from '@/data/updater'
import { AppSidebar } from './AppSidebar'
import { BackgroundLayer } from './BackgroundLayer'
import { GlobalSurfaces } from './GlobalSurfaces'
import { ModpackSurfaces } from './ModpackSurfaces'
import { RouteError } from './RouteStates'
import { openInstance, runCommand } from './commands'
import { router } from './router'
import { useUi } from './ui-store'

/** A native notification, only while the window is in the background (B11 tier 2). */
function notifyIfBackground(title: string, body: string, onClick?: () => void) {
  if (document.hasFocus() || typeof Notification === 'undefined') return
  const n = new Notification(title, { body, silent: false })
  n.addEventListener('click', () => {
    void api.window.focusMain().catch(() => {})
    onClick?.()
  })
}

/** Main-window reactions to launches, tasks and updates. */
function useWindowReactions() {
  useEffect(() => {
    const dispose = installDockProgress()
    setTaskFinishedHandler((t) => {
      if (t.state === 'succeeded' && (t.name === 'install.run' || t.name === 'java.install' || t.name.startsWith('modpack.'))) notifyIfBackground('Finished', taskTitle(t).replace(/^Installing/, 'Installed'))
      if (t.state === 'failed') notifyIfBackground('Something failed', `${taskTitle(t)}: ${t.error?.message ?? 'failed'}`)
    })
    setLaunchEventHandler({
      started(instanceId) {
        const settings = queryClient.getQueryData<AppSettings>(settingsKey)
        const detail = queryClient.getQueryData<RuntimeDetail | null>(instanceKeys.detail(instanceId))
        if (detail?.overrides.showLogWindow ?? settings?.game.openLogOnStart) openInstance(instanceId, 'logs')
      },
      exited(instanceId, exit) {
        const inst = getInstanceSummary(instanceId)
        const name = inst?.name ?? 'Minecraft'
        const showLogs = () => openInstance(instanceId, 'logs')
        if (exit.crashed) {
          void api.window.focusMain().catch(() => {})
          showLogs()
          toast({
            kind: 'error',
            title: `Minecraft crashed: “${name}”`,
            message: exit.nativeLoadError ? 'A native library failed to load.' : exit.code !== null ? `Exit code ${exit.code}.` : undefined,
            actions: [{ label: 'Show Logs', onClick: showLogs }],
          })
          notifyIfBackground('Minecraft crashed', `“${name}” stopped unexpectedly.`, showLogs)
        } else if (exit.killed) {
          toast({ kind: 'success', title: `Stopped “${name}”` })
        }
      },
    })
    return () => {
      dispose()
      setLaunchEventHandler({})
    }
  }, [])

  // "Restart to Update": one toast when an update becomes ready (B14).
  const updater = useUpdaterState()
  const announced = useRef<string>(undefined)
  useEffect(() => {
    if (updater.status !== 'ready' || announced.current === updater.version) return
    announced.current = updater.version
    toast({
      kind: 'info',
      title: `Amethyst ${updater.version} is ready`,
      message: 'Restart to update. It also installs the next time you quit.',
      duration: 0,
      actions: [{ label: 'Restart Now', onClick: () => void updaterActions.restart() }],
    })
    notifyIfBackground('Update ready', `Amethyst ${updater.version} installs when you restart.`)
  }, [updater])
}

/** Tells main which instance is selected, so the native Instance menu is enabled to match (B13). */
function useMenuContext() {
  const instanceId = useRouterState({ select: (s) => s.matches.map((m) => (m.params as { instanceId?: string }).instanceId).find(Boolean) })
  const { data } = useInstances()
  const inst = instanceId ? data?.find((i) => i.id === instanceId) : undefined
  // Only the fields the menu shows, so list refreshes that change nothing else don't call main.
  const id = inst?.id
  const kind = inst?.state.kind
  const pinned = inst?.pinned ?? false
  useEffect(() => {
    const instance = id && kind ? { id, canPlay: kind === 'idle', canStop: kind === 'running' || kind === 'launching', pinned } : null
    void api.window.setMenuContext({ instance }).catch(() => {})
  }, [id, kind, pinned])
}

/** Sends the window to first run when the runtime says consent was never asked (fresh data root). */
function useFirstRunGate() {
  const loaded = useSettingsLoaded()
  const settings = useAppSettings()
  useEffect(() => {
    if (loaded && reconcileFirstRun(settings) === 'first-run') void router.navigate({ to: '/welcome', replace: true })
  }, [loaded, settings])
}

/** The main window: vibrancy sidebar + opaque content area + window-wide surfaces (B1). */
export function Shell() {
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // Native menu bar → the same command dispatcher the palette uses.
  useEffect(() => subscribe('menu:command', ({ command, arg }) => runCommand(command, arg)), [])
  useWindowReactions()
  useMenuContext()
  useFirstRunGate()

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
      <ModpackSurfaces />
    </div>
  )
}
