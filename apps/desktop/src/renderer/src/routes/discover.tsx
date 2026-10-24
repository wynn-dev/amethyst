import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { Download, Heart, LayoutGrid, List, PanelLeftClose, PanelLeftOpen, SearchX, Target, WifiOff, X } from 'lucide-react'
import {
  Banner,
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  SearchField,
  Segmented,
  Select,
  Skeleton,
  ToolbarTitle,
  VirtualList,
  cn,
} from '@/ui'
import { useInstances, versionLabel } from '@/data/instances'
import { useProjectSearch } from '@/data/misc'
import type { InstanceSummary, LoaderKind, ProjectHit, ProjectType } from '@/data/types'
import { PageToolbar } from '@/app/PageToolbar'
import { QueryError } from '@/app/RouteStates'
import { findTargetRef } from '@/app/ui-store'
import { BlockIcon, formatCount, formatRelative } from '@/app/visuals'
import { FavouriteButton, InstallButton, SourceBadge, TYPE_LABELS, useFavourites } from './discover-parts'

type Sort = 'relevance' | 'downloads' | 'follows' | 'updated' | 'newest'
type View = 'list' | 'grid'

interface Filters {
  sort: Sort
  gameVersion: string
  loader: 'any' | LoaderKind
  environment: 'any' | 'client' | 'server'
  categories: string[]
  hideInstalled: boolean
  favouritesOnly: boolean
}

const DEFAULT_FILTERS: Filters = { sort: 'relevance', gameVersion: 'any', loader: 'any', environment: 'any', categories: [], hideInstalled: false, favouritesOnly: false }
const CATEGORIES = ['Adventure', 'Decoration', 'Magic', 'Optimization', 'Quests', 'Storage', 'Technology', 'Utility', 'Worldgen']

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

/** Discover (B5): one browser for every project type on Modrinth and CurseForge. */
export function DiscoverPage() {
  const search = useSearch({ from: '/shell/discover' })
  const navigate = useNavigate({ from: '/discover/' })
  const type: ProjectType = search.type ?? (search.target ? 'mod' : 'modpack')
  const source = search.source ?? 'all'
  const [query, setQuery] = useState(search.q ?? '')
  const deferred = useDeferredValue(query.trim())
  const [view, setView] = useState<View>('list')
  const [filtersOpen, setFiltersOpen] = useState(true)
  const { data: instances = [] } = useInstances()
  const target = instances.find((i) => i.id === search.target)
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine)
  const favourites = useFavourites((s) => s.ids)

  // Keep the URL in sync with the query (debounced by useDeferredValue) so Back restores it.
  useEffect(() => {
    if ((search.q ?? '') !== deferred) navigate({ search: (s) => ({ ...s, q: deferred || undefined }), replace: true })
  }, [deferred, search.q, navigate])

  const results = useProjectSearch(type, deferred, source)

  const hits = useMemo(() => {
    let list = (results.data ?? []).map((p) => (target ? { ...p, compatible: p.gameVersions.includes(target.minecraft) && (p.loaders.length === 0 || p.loaders.includes(target.loader.kind)) } : p))
    if (filters.hideInstalled) list = list.filter((p) => !p.installed)
    if (filters.favouritesOnly) list = list.filter((p) => favourites.includes(p.id))
    if (filters.gameVersion !== 'any') list = list.filter((p) => p.gameVersions.includes(filters.gameVersion))
    if (filters.loader !== 'any') list = list.filter((p) => p.loaders.length === 0 || p.loaders.includes(filters.loader as LoaderKind))
    if (filters.categories.length) list = list.filter((p) => p.categories.some((c) => filters.categories.includes(c.charAt(0).toUpperCase() + c.slice(1))))
    const by: Record<Sort, (p: ProjectHit) => number> = {
      relevance: () => 0,
      downloads: (p) => -p.downloads,
      follows: (p) => -p.follows,
      updated: (p) => -p.updatedAt,
      newest: (p) => -p.updatedAt,
    }
    return filters.sort === 'relevance' ? list : list.toSorted((a, b) => by[filters.sort](a) - by[filters.sort](b))
  }, [results.data, filters, target, favourites])

  const filtered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS)
  const clearFilters = () => setFilters(DEFAULT_FILTERS)
  const landing = !deferred && !filtered

  return (
    <>
      <PageToolbar
        leading={<ToolbarTitle title="Discover" />}
        trailing={
          <>
            <SearchField
              ref={findTargetRef}
              value={query}
              onValueChange={setQuery}
              placeholder={`Search ${TYPE_LABELS[type].many.toLowerCase()}`}
              className="w-[220px]"
            />
            <Select
              aria-label="Source"
              value={source}
              onValueChange={(v) => navigate({ search: (s) => ({ ...s, source: v === 'all' ? undefined : v }) })}
              options={[
                { value: 'all', label: 'All Sources' },
                { value: 'modrinth', label: 'Modrinth' },
                { value: 'curseforge', label: 'CurseForge' },
              ]}
              className="w-[118px]"
            />
            <Segmented
              aria-label="View as"
              value={view}
              onValueChange={setView}
              options={[
                { value: 'list', label: <List />, 'aria-label': 'List' },
                { value: 'grid', label: <LayoutGrid />, 'aria-label': 'Grid' },
              ]}
            />
          </>
        }
      />
      <div className="flex shrink-0 items-center justify-center border-b border-separator py-2">
        <Segmented
          aria-label="Project type"
          value={type}
          onValueChange={(t) => navigate({ search: (s) => ({ ...s, type: t }) })}
          options={(Object.keys(TYPE_LABELS) as ProjectType[]).map((t) => ({ value: t, label: TYPE_LABELS[t].many }))}
        />
      </div>
      {target && <TargetBar target={target} instances={instances} />}
      <div className="flex min-h-0 flex-1">
        {filtersOpen && <FilterSidebar filters={filters} setFilters={setFilters} target={target} onClose={() => setFiltersOpen(false)} />}
        <div className="flex min-w-0 flex-1 flex-col">
          {!filtersOpen && (
            <div className="px-4 pt-3">
              <Button size="sm" variant="borderless" icon={<PanelLeftOpen />} onClick={() => setFiltersOpen(true)}>
                Show Filters
              </Button>
            </div>
          )}
          {!online && (
            <Banner
              tone="warning"
              icon={<WifiOff />}
              title="You’re offline"
              className="mx-4 mt-3"
              actions={
                <Button size="sm" onClick={() => results.refetch()}>
                  Retry
                </Button>
              }
            >
              Installed content and Favourites are still available.
            </Banner>
          )}
          {results.isPending ? (
            <ResultsSkeleton view={view} />
          ) : results.isError ? (
            <QueryError error={results.error} onRetry={() => results.refetch()} what={TYPE_LABELS[type].many.toLowerCase()} />
          ) : hits.length === 0 ? (
            <EmptyState
              icon={<SearchX />}
              title={deferred ? `No results for “${deferred}”` : 'No results'}
              description={filtered ? 'Try removing some filters.' : `Nothing matches in ${source === 'all' ? 'Modrinth or CurseForge' : source === 'modrinth' ? 'Modrinth' : 'CurseForge'}.`}
              actions={filtered ? <Button onClick={clearFilters}>Clear Filters</Button> : undefined}
            />
          ) : (
            <Results hits={hits} view={view} target={target} heading={landing ? `Popular ${TYPE_LABELS[type].many}${target ? ` for ${target.minecraft}` : ' for 1.21.1'}` : `${hits.length} results`} featured={landing ? hits.slice(0, 3) : undefined} />
          )}
        </div>
      </div>
    </>
  )
}

function TargetBar({ target, instances }: { target: InstanceSummary; instances: InstanceSummary[] }) {
  const navigate = useNavigate({ from: '/discover/' })
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-separator bg-accent-soft px-4 py-1.5 text-body">
      <Target className="size-3.5 text-accent" />
      <span className="text-label-2">Installing to:</span>
      <Select
        aria-label="Target instance"
        variant="borderless"
        value={target.id}
        onValueChange={(id) => navigate({ search: (s) => ({ ...s, target: id }) })}
        options={instances.map((i) => ({ value: i.id, label: i.name, text: i.name }))}
        className="font-medium"
      />
      <span className="text-label-2">· {versionLabel(target)}</span>
      <IconButton label="Clear target instance" size="sm" className="ml-auto" onClick={() => navigate({ search: (s) => ({ ...s, target: undefined }) })}>
        <X />
      </IconButton>
    </div>
  )
}

function FilterSidebar({ filters, setFilters, target, onClose }: { filters: Filters; setFilters: (f: Filters) => void; target?: InstanceSummary; onClose: () => void }) {
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch })
  return (
    <aside aria-label="Filters" className="flex w-[208px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-separator bg-window-2 px-3 py-3">
      <div className="flex items-center justify-between">
        <h2 className="text-small font-semibold text-label-2">Filters</h2>
        <IconButton label="Hide Filters" size="sm" onClick={onClose}>
          <PanelLeftClose />
        </IconButton>
      </div>
      <FilterGroup label="Sort by">
        <Select<Sort>
          aria-label="Sort by"
          value={filters.sort}
          onValueChange={(sort) => set({ sort })}
          className="w-full"
          options={[
            { value: 'relevance', label: 'Relevance' },
            { value: 'downloads', label: 'Downloads' },
            { value: 'follows', label: 'Follows' },
            { value: 'updated', label: 'Recently Updated' },
            { value: 'newest', label: 'Newest' },
          ]}
        />
      </FilterGroup>
      <FilterGroup label="Game version">
        <Select
          aria-label="Game version"
          value={filters.gameVersion}
          onValueChange={(gameVersion) => set({ gameVersion })}
          className="w-full"
          options={[{ value: 'any', label: target ? `Any (target: ${target.minecraft})` : 'Any' }, ...['1.21.4', '1.21.1', '1.20.1', '1.19.2', '1.18.2', '1.16.5', '1.12.2'].map((v) => ({ value: v, label: v }))]}
        />
      </FilterGroup>
      <FilterGroup label="Loader">
        <Select
          aria-label="Loader"
          value={filters.loader}
          onValueChange={(loader) => set({ loader: loader as Filters['loader'] })}
          className="w-full"
          options={[
            { value: 'any', label: 'Any' },
            { value: 'fabric', label: 'Fabric' },
            { value: 'quilt', label: 'Quilt' },
            { value: 'forge', label: 'Forge' },
            { value: 'neoforge', label: 'NeoForge' },
          ]}
        />
      </FilterGroup>
      <FilterGroup label="Environment">
        <Segmented
          aria-label="Environment"
          size="sm"
          value={filters.environment}
          onValueChange={(environment) => set({ environment })}
          options={[
            { value: 'any', label: 'Any' },
            { value: 'client', label: 'Client' },
            { value: 'server', label: 'Server' },
          ]}
        />
      </FilterGroup>
      <FilterGroup label="Categories">
        <div className="flex flex-col gap-1.5">
          {CATEGORIES.map((c) => (
            <Checkbox
              key={c}
              label={c}
              checked={filters.categories.includes(c)}
              onCheckedChange={(on) => set({ categories: on ? [...filters.categories, c] : filters.categories.filter((x) => x !== c) })}
            />
          ))}
        </div>
      </FilterGroup>
      <FilterGroup label="Show">
        <div className="flex flex-col gap-1.5">
          <Checkbox label="Favourites only" checked={filters.favouritesOnly} onCheckedChange={(favouritesOnly) => set({ favouritesOnly })} />
          {target && <Checkbox label="Hide installed" checked={filters.hideInstalled} onCheckedChange={(hideInstalled) => set({ hideInstalled })} />}
        </div>
      </FilterGroup>
    </aside>
  )
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-small font-medium text-label-2">{label}</span>
      {children}
    </div>
  )
}

const LIST_ROW = 84

function Results({ hits, view, target, heading, featured }: { hits: ProjectHit[]; view: View; target?: InstanceSummary; heading: string; featured?: ProjectHit[] }) {
  const header = (
    <>
      {featured && featured.length > 0 && (
        <section aria-label="Featured" className="grid grid-cols-3 gap-3 px-4 pt-4">
          {featured.map((p) => (
            <FeaturedCard key={p.id} project={p} target={target} />
          ))}
        </section>
      )}
      <h2 className="px-4 pt-4 pb-1 text-title3 font-semibold">{heading}</h2>
    </>
  )
  if (view === 'grid') {
    // Virtualise rows of three cards; card height is fixed so nothing is measured.
    const rows: ProjectHit[][] = []
    for (let i = 0; i < hits.length; i += 3) rows.push(hits.slice(i, i + 3))
    return (
      <VirtualList
        items={rows}
        rowHeight={196}
        getKey={(r) => r.map((p) => p.id).join()}
        aria-label="Results"
        header={header}
        paddingY={6}
        className="flex-1"
        renderRow={(row) => (
          <div className="grid h-full grid-cols-3 gap-3 px-4 pb-3">
            {row.map((p) => (
              <GridCard key={p.id} project={p} target={target} />
            ))}
          </div>
        )}
      />
    )
  }
  return (
    <VirtualList
      items={hits}
      rowHeight={LIST_ROW}
      getKey={(p) => p.id}
      aria-label="Results"
      header={header}
      paddingY={4}
      className="flex-1"
      renderRow={(p) => <ListRow project={p} target={target} />}
    />
  )
}

function Meta({ project }: { project: ProjectHit }) {
  return (
    <span className="flex items-center gap-2.5 text-small text-label-2">
      <SourceBadge source={project.source} />
      <span className="flex items-center gap-1 tabular">
        <Download className="size-3" /> {formatCount(project.downloads)}
      </span>
      <span className="flex items-center gap-1 tabular">
        <Heart className="size-3" /> {formatCount(project.follows)}
      </span>
      <span>Updated {formatRelative(project.updatedAt)}</span>
    </span>
  )
}

function Compat({ project }: { project: ProjectHit }) {
  if (project.compatible === undefined) return null
  return project.compatible ? (
    <span className="text-small font-medium text-green">Compatible</span>
  ) : (
    <span className="text-small font-medium text-orange" title="No version supports the target instance">
      Not compatible
    </span>
  )
}

function ListRow({ project, target }: { project: ProjectHit; target?: InstanceSummary }) {
  return (
    <div className="mx-2 flex h-[80px] items-center gap-3 rounded-xl px-3 hover:bg-fill">
      <BlockIcon hue={project.hue} label={project.title} size={52} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Link
            to="/discover/$projectId"
            params={{ projectId: project.id }}
            search={(s) => s}
            className="truncate text-body font-semibold text-label hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {project.title}
          </Link>
          <span className="shrink-0 text-small text-label-2">by {project.author}</span>
          <Compat project={project} />
        </div>
        <p className="truncate text-callout text-label-2">{project.summary}</p>
        <div className="mt-1">
          <Meta project={project} />
        </div>
      </div>
      <FavouriteButton project={project} size="sm" />
      <InstallButton project={project} target={target} />
    </div>
  )
}

function GridCard({ project, target }: { project: ProjectHit; target?: InstanceSummary }) {
  return (
    <div className="flex h-full flex-col gap-2 rounded-xl bg-surface p-3 shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
      <div className="flex items-start gap-3">
        <BlockIcon hue={project.hue} label={project.title} size={44} />
        <div className="min-w-0 flex-1">
          <Link to="/discover/$projectId" params={{ projectId: project.id }} search={(s) => s} className="line-clamp-1 text-body font-semibold hover:underline">
            {project.title}
          </Link>
          <p className="truncate text-small text-label-2">by {project.author}</p>
        </div>
        <FavouriteButton project={project} size="sm" />
      </div>
      <p className="line-clamp-2 flex-1 text-callout text-label-2">{project.summary}</p>
      <Meta project={project} />
      <div className="flex items-center justify-between">
        <Compat project={project} />
        <span className="ml-auto">
          <InstallButton project={project} target={target} size="sm" />
        </span>
      </div>
    </div>
  )
}

function FeaturedCard({ project, target }: { project: ProjectHit; target?: InstanceSummary }) {
  return (
    <div className="relative flex h-[132px] flex-col justify-end overflow-hidden rounded-xl p-3 text-white shadow-card">
      <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, hsl(${project.hue} 55% 48%), hsl(${(project.hue + 50) % 360} 60% 30%))` }} />
      <div className="relative flex items-end gap-2.5">
        <BlockIcon hue={(project.hue + 20) % 360} label={project.title} size={40} />
        <div className="min-w-0 flex-1">
          <p className="text-caption font-semibold tracking-[0.06em] text-white/70 uppercase">Featured</p>
          <Link to="/discover/$projectId" params={{ projectId: project.id }} search={(s) => s} className="block truncate text-title3 font-semibold after:absolute after:inset-0">
            {project.title}
          </Link>
          <p className="truncate text-small text-white/75">{project.summary}</p>
        </div>
      </div>
      <span className="relative mt-2 flex justify-end">
        <InstallButton project={project} target={target} size="sm" />
      </span>
    </div>
  )
}

function ResultsSkeleton({ view }: { view: View }) {
  return (
    <div role="status" aria-label="Loading results" className={cn('flex-1 overflow-hidden px-4 pt-4', view === 'grid' ? 'grid grid-cols-3 content-start gap-3' : 'flex flex-col gap-1')}>
      {Array.from({ length: view === 'grid' ? 6 : 7 }, (_, i) =>
        view === 'grid' ? (
          <Skeleton key={i} className="h-[184px] rounded-xl" />
        ) : (
          <div key={i} className="flex h-[80px] items-center gap-3 px-1">
            <Skeleton className="size-[52px] rounded-xl" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-2.5 w-2/3" />
              <Skeleton className="h-2.5 w-1/4" />
            </div>
            <Skeleton className="h-6 w-20 rounded-md" />
          </div>
        ),
      )}
    </div>
  )
}
