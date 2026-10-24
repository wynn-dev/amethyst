import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router'
import type { InstanceTab } from '@shared/menu'
import type { ProjectType } from '@/data/types'
import { useFirstRun } from '@/data/firstRun'
import { Shell } from './Shell'
import { RouteError, RoutePending } from './RouteStates'

/*
 * Code-based route tree. Every page is a lazy chunk; only the shell (sidebar, toolbar items,
 * palette trigger) is in the entry bundle.
 *
 *   /                                  Home
 *   /discover?type&q&source&target     Discover
 *   /discover/$projectId               Project page
 *   /instances/$instanceId/<tab>       Instance detail (overview … settings)
 *   /settings/$pane                    Settings window (separate BrowserWindow)
 *   /welcome                           First run
 */

const rootRoute = createRootRoute({ component: Outlet })

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: Shell,
  beforeLoad: () => {
    if (!useFirstRun.getState().completed) throw redirect({ to: '/welcome' })
  },
})

const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: lazyRouteComponent(() => import('@/routes/home'), 'HomePage'),
})

export interface DiscoverSearch {
  type?: ProjectType
  q?: string
  source?: 'all' | 'modrinth' | 'curseforge'
  target?: string
}

const PROJECT_TYPES = new Set<string>(['modpack', 'mod', 'resourcepack', 'shader', 'datapack', 'world'])

const discoverRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'discover',
  validateSearch: (s: Record<string, unknown>): DiscoverSearch => ({
    type: PROJECT_TYPES.has(s.type as string) ? (s.type as ProjectType) : undefined,
    q: typeof s.q === 'string' && s.q ? s.q : undefined,
    source: s.source === 'modrinth' || s.source === 'curseforge' ? s.source : undefined,
    target: typeof s.target === 'string' ? s.target : undefined,
  }),
})

const discoverIndexRoute = createRoute({
  getParentRoute: () => discoverRoute,
  path: '/',
  component: lazyRouteComponent(() => import('@/routes/discover'), 'DiscoverPage'),
})

const projectRoute = createRoute({
  getParentRoute: () => discoverRoute,
  path: '$projectId',
  component: lazyRouteComponent(() => import('@/routes/project'), 'ProjectPage'),
})

const instanceRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'instances/$instanceId',
  component: lazyRouteComponent(() => import('@/routes/instance/layout'), 'InstanceLayout'),
})

const instanceIndexRoute = createRoute({
  getParentRoute: () => instanceRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/instances/$instanceId/overview', params, replace: true })
  },
})

// One lazy chunk per tab.
const tab = <P extends InstanceTab>(path: P, load: () => Promise<{ default: () => React.ReactNode }>) =>
  createRoute({ getParentRoute: () => instanceRoute, path, component: lazyRouteComponent(load) })

const instanceTabRoutes = [
  tab('overview', () => import('@/routes/instance/overview')),
  tab('mods', () => import('@/routes/instance/mods')),
  tab('resource-packs', () => import('@/routes/instance/resource-packs')),
  tab('shaders', () => import('@/routes/instance/shaders')),
  tab('worlds', () => import('@/routes/instance/worlds')),
  tab('logs', () => import('@/routes/instance/logs')),
  tab('settings', () => import('@/routes/instance/settings')),
] as const

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'settings',
  component: lazyRouteComponent(() => import('@/routes/settings-window/SettingsWindow'), 'SettingsWindow'),
})

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/settings/$pane', params: { pane: 'general' }, replace: true })
  },
})

const settingsPaneRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '$pane',
  validateSearch: (s: Record<string, unknown>): { row?: string } => ({ row: typeof s.row === 'string' ? s.row : undefined }),
  component: lazyRouteComponent(() => import('@/routes/settings-window/panes'), 'SettingsPane'),
})

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'welcome',
  component: lazyRouteComponent(() => import('@/routes/first-run/FirstRun'), 'FirstRun'),
})

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    homeRoute,
    discoverRoute.addChildren([discoverIndexRoute, projectRoute]),
    instanceRoute.addChildren([instanceIndexRoute, ...instanceTabRoutes]),
  ]),
  settingsRoute.addChildren([settingsIndexRoute, settingsPaneRoute]),
  welcomeRoute,
])

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: 'intent',
  defaultPendingComponent: RoutePending,
  defaultPendingMs: 150,
  defaultErrorComponent: RouteError,
  // Preserve scroll per route like a native app's back/forward.
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
