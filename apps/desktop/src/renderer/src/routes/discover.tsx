import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { AlertTriangle, Box, LayoutGrid, List, ListFilter, PanelLeftClose, SearchX, Star, WifiOff, X } from 'lucide-react'
import type { MarketPlatform, MarketProjectRow, MarketProjectType, MarketSearchQuery } from '@shared/services'
import { Banner, Button, Checkbox, EmptyState, IconButton, SearchField, Segmented, Select, Skeleton, Spinner, TabStrip, VirtualList, cn, tabPanelProps } from '@/ui'
import { chipButtonClass } from '@/ui/Chips'
import { useQuery } from '@tanstack/react-query'
import { PageToolbar } from '@/app/PageToolbar'
import { QueryError } from '@/app/RouteStates'
import { findTargetRef } from '@/app/ui-store'
import { formatCount, formatDate } from '@/app/visuals'
import { useInstanceRows, runtimeLabel, type RuntimeInstanceRow } from '@/data/instance-info'
import { useFavourites, useMarketSearch, useMarketStatus, type Favourite } from '@/data/market'
import { api } from '@/lib/rpc'
import { errorMessage } from '@/lib/error-messages'
import { FavouriteButton, InstallButton, ProjectIcon, SourceBadge, TYPE_LABELS, eligible, shortAgo } from './discover-parts'

type Sort = NonNullable<MarketSearchQuery['sort']>
type View = 'list' | 'grid'

interface Filters {
  sort: Sort | 'auto'
  /** `target`: the target instance's version. */
  gameVersion: string
  loader: string
  environment: 'any' | 'client' | 'server'
  categories: string[]
  hideInstalled: boolean
  favouritesOnly: boolean
}

const DEFAULT_FILTERS: Filters = { sort: 'auto', gameVersion: 'target', loader: 'target', environment: 'any', categories: [], hideInstalled: false, favouritesOnly: false }

/** Modrinth category names with labels. CurseForge category ids differ per class; they are not offered here. */
const CATEGORIES: Partial<Record<MarketProjectType, [string, string][]>> = {
  mod: [
    ['adventure', 'Adventure'],
    ['decoration', 'Decoration'],
    ['equipment', 'Equipment'],
    ['library', 'Library'],
    ['magic', 'Magic'],
    ['optimization', 'Optimization'],
    ['storage', 'Storage'],
    ['technology', 'Technology'],
    ['utility', 'Utility'],
    ['worldgen', 'World Generation'],
  ],
  modpack: [
    ['adventure', 'Adventure'],
    ['challenging', 'Challenging'],
    ['combat', 'Combat'],
    ['kitchen-sink', 'Kitchen Sink'],
    ['lightweight', 'Lightweight'],
    ['magic', 'Magic'],
    ['multiplayer', 'Multiplayer'],
    ['optimization', 'Optimization'],
    ['quests', 'Quests'],
    ['technology', 'Technology'],
  ],
  resourcepack: [
    ['16x', '16×'],
    ['32x', '32×'],
    ['64x', '64×'],
    ['realistic', 'Realistic'],
    ['simplistic', 'Simplistic'],
    ['themed', 'Themed'],
    ['vanilla-like', 'Vanilla-like'],
  ],
  shader: [
    ['cartoon', 'Cartoon'],
    ['cursed', 'Cursed'],
    ['fantasy', 'Fantasy'],
    ['realistic', 'Realistic'],
    ['semi-realistic', 'Semi-realistic'],
    ['vanilla-like', 'Vanilla-like'],
  ],
}

const LOADERS: [string, string][] = [
  ['fabric', 'Fabric'],
  ['quilt', 'Quilt'],
  ['forge', 'Forge'],
  ['neoforge', 'NeoForge'],
]

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

/** Release versions for the version filter (from the runtime's cached manifest). */
function useReleaseVersions() {
  return useQuery({ queryKey: ['discover', 'release-versions'], queryFn: async () => (await api.versions.listMinecraft({ types: ['release'] })).items.map((v) => v.id), staleTime: 60 * 60_000 })
}

/** Discover (B5): one browser for every project type on Modrinth and CurseForge. */
export function DiscoverPage() {
  const search = useSearch({ from: '/shell/discover' })
  const navigate = useNavigate({ from: '/discover/' })
  const type: MarketProjectType = search.type ?? (search.target ? 'mod' : 'modpack')
  const source = search.source ?? 'all'
  const [query, setQuery] = useState(search.q ?? '')
  const deferred = useDeferredValue(query.trim())
  const [view, setView] = useState<View>('list')
  // Results get the full width; the filter column opens from the Filters chip.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const { data: instances = [] } = useInstanceRows()
  const target = instances.find((i) => i.id === search.target)
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine)
  const status = useMarketStatus()
  const cfOff = status.data?.curseforge === false

  // Keep the URL in sync with the query (debounced by useDeferredValue) so Back restores it.
  useEffect(() => {
    if ((search.q ?? '') !== deferred) navigate({ search: (s) => ({ ...s, q: deferred || undefined }), replace: true })
  }, [deferred, search.q, navigate])

  const gameVersion = filters.gameVersion === 'target' ? target?.minecraft : filters.gameVersion === 'any' ? undefined : filters.gameVersion
  const loader = type === 'mod' || type === 'modpack' ? (filters.loader === 'target' ? (type === 'mod' ? target?.loader?.kind : undefined) : filters.loader === 'any' ? undefined : filters.loader) : undefined
  const platforms: MarketPlatform[] | undefined = source === 'all' ? undefined : [source]
  const marketQuery = useMemo<MarketSearchQuery>(
    () => ({
      projectType: type,
      ...(deferred ? { query: deferred } : {}),
      ...(gameVersion ? { gameVersion } : {}),
      ...(loader ? { loader } : {}),
      ...(filters.categories.length ? { modrinthCategories: filters.categories } : {}),
      ...(filters.environment !== 'any' ? { environment: filters.environment } : {}),
      ...(filters.sort !== 'auto' ? { sort: filters.sort } : {}),
      pageSize: 20,
      ...(platforms ? { platforms } : {}),
      ...(target ? { instanceId: target.id } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- platforms derives from source
    [type, deferred, gameVersion, loader, filters, source, target?.id],
  )
  const sourceUnavailable = source === 'curseforge' && cfOff
  const results = useMarketSearch(marketQuery)
  const favourites = useFavourites((s) => s.items)

  const hits = useMemo(() => {
    if (filters.favouritesOnly) {
      const q = deferred.toLowerCase()
      return Object.values(favourites)
        .filter((f) => (f.projectType ?? 'mod') === type && (source === 'all' || f.platform === source) && (!q || f.title.toLowerCase().includes(q)))
        .map(favouriteRow)
    }
    const seen = new Set<string>()
    let list = (results.data?.pages ?? []).flatMap((p) => p.items).filter((p) => (seen.has(p.key) ? false : (seen.add(p.key), true)))
    if (filters.hideInstalled) list = list.filter((p) => !p.installed)
    return list
  }, [results.data, filters.favouritesOnly, filters.hideInstalled, favourites, type, source, deferred])
  const errors = results.data?.pages.at(-1)?.errors ?? {}
  const failed = (Object.entries(errors) as [MarketPlatform, { code: string; message: string }][]).filter(([p]) => !(p === 'curseforge' && cfOff))

  const filtered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS)
  // Active filters in the filter column (sort lives in the tab row).
  const filterCount =
    (filters.gameVersion !== DEFAULT_FILTERS.gameVersion ? 1 : 0) +
    (filters.loader !== DEFAULT_FILTERS.loader ? 1 : 0) +
    (filters.environment !== 'any' ? 1 : 0) +
    filters.categories.length +
    (filters.hideInstalled ? 1 : 0) +
    (filters.favouritesOnly ? 1 : 0)
  const clearFilters = () => setFilters(DEFAULT_FILTERS)
  const landing = !deferred && !filtered && !filters.favouritesOnly
  const totalLabel = results.data ? results.data.pages[0]?.total : undefined

  return (
    <>
      <h1 className="sr-only">Discover</h1>
      <PageToolbar
        separator={false}
        leading={
          <SearchField
            ref={findTargetRef}
            value={query}
            onValueChange={setQuery}
            placeholder={`Search ${TYPE_LABELS[type].many.toLowerCase()}`}
            size="lg"
            className="w-[360px] min-w-0 shrink"
          />
        }
        trailing={
          <>
            <Select
              aria-label="Source"
              variant="borderless"
              value={source}
              onValueChange={(v) => navigate({ search: (s) => ({ ...s, source: v === 'all' ? undefined : (v as MarketPlatform) }) })}
              options={[
                { value: 'all', label: 'All Sources' },
                { value: 'modrinth', label: 'Modrinth' },
                { value: 'curseforge', label: cfOff ? 'CurseForge (unavailable)' : 'CurseForge', text: 'CurseForge' },
              ]}
              className="text-label-2"
            />
            <Segmented
              aria-label="View as"
              size="sm"
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
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-separator pr-3 pl-2.5">
        <TabStrip
          aria-label="Project type"
          panelId="discover-panel"
          value={type}
          onValueChange={(t) => {
            setFilters((f) => ({ ...f, categories: [] }))
            navigate({ search: (s) => ({ ...s, type: t }) })
          }}
          items={(Object.keys(TYPE_LABELS) as MarketProjectType[]).map((t) => ({ value: t, label: TYPE_LABELS[t].many }))}
          className="min-w-0"
        />
        <div className="flex-1" />
        {target && <TargetBar target={target} instances={eligible(instances, type === 'modpack' ? 'mod' : type)} />}
        <button
          type="button"
          aria-expanded={filtersOpen}
          aria-controls="discover-filters"
          aria-label={filterCount ? `Filters, ${filterCount} active` : 'Filters'}
          onClick={() => setFiltersOpen((o) => !o)}
          className={cn(chipButtonClass, (filtersOpen || filterCount > 0) && 'text-label', filtersOpen && 'bg-fill')}
        >
          <ListFilter />
          Filters
          {filterCount > 0 && <span className="font-mono text-[10.5px] text-label-3 tabular">{filterCount}</span>}
        </button>
        <Select
          aria-label="Sort by"
          variant="borderless"
          value={filters.sort}
          onValueChange={(sort) => setFilters({ ...filters, sort: sort as Filters['sort'] })}
          options={[
            { value: 'auto', label: 'Relevance' },
            { value: 'downloads', label: 'Downloads' },
            { value: 'follows', label: 'Follows' },
            { value: 'updated', label: 'Recently Updated' },
            { value: 'newest', label: 'Newest' },
          ]}
          className="text-label-2"
        />
      </div>
      <div {...tabPanelProps('discover-panel', type)} className="flex min-h-0 flex-1">
        {filtersOpen && <FilterSidebar type={type} filters={filters} setFilters={setFilters} target={target} onClose={() => setFiltersOpen(false)} />}
        <div className="flex min-w-0 flex-1 flex-col">
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
          {online && failed.length > 0 && !results.isError && (
            <Banner
              tone="warning"
              icon={<AlertTriangle />}
              title={`${failed.map(([p]) => (p === 'modrinth' ? 'Modrinth' : 'CurseForge')).join(' and ')} ${failed.length > 1 ? 'are' : 'is'} unavailable`}
              className="mx-4 mt-3"
              actions={
                <Button size="sm" onClick={() => results.refetch()}>
                  Retry
                </Button>
              }
            >
              {errorMessage({ ...failed[0]![1], details: { platform: failed[0]![0] } })} Results from the other source are still shown.
            </Banner>
          )}
          {cfOff && source === 'all' && type !== 'datapack' && !failed.length && (
            <p className="px-4 pt-2.5 text-meta text-label-3">CurseForge isn’t available in this build, so results come from Modrinth.</p>
          )}
          {sourceUnavailable ? (
            <EmptyState
              icon={<AlertTriangle />}
              title="CurseForge unavailable"
              description={status.data?.curseforgeReason === 'forbidden' ? 'CurseForge rejected this build’s API key.' : 'This build of Amethyst has no CurseForge API key, so CurseForge can’t be searched. Modrinth works as usual.'}
              actions={<Button onClick={() => navigate({ search: (s) => ({ ...s, source: 'modrinth' }) })}>Search Modrinth</Button>}
            />
          ) : results.isPending && !filters.favouritesOnly ? (
            <ResultsSkeleton view={view} />
          ) : results.isError && !filters.favouritesOnly ? (
            <QueryError error={new Error(errorMessage(results.error))} onRetry={() => results.refetch()} what={TYPE_LABELS[type].many.toLowerCase()} />
          ) : hits.length === 0 ? (
            <EmptyState
              icon={filters.favouritesOnly ? <Star /> : <SearchX />}
              title={filters.favouritesOnly ? 'No favourites yet' : deferred ? `No results for “${deferred}”` : 'No results'}
              description={filters.favouritesOnly ? 'Star a project to keep it here, even offline.' : filtered ? 'Try removing some filters.' : undefined}
              actions={filtered ? <Button onClick={clearFilters}>Clear Filters</Button> : undefined}
            />
          ) : (
            <Results
              hits={hits}
              view={view}
              target={target}
              heading={
                filters.favouritesOnly
                  ? `${hits.length} favourite${hits.length === 1 ? '' : 's'}`
                  : landing
                    ? `Popular ${TYPE_LABELS[type].many}${gameVersion ? ` for ${gameVersion}` : ''}`
                    : `${formatCount(totalLabel ?? hits.length)} results`
              }
              featured={landing && !search.target ? hits.slice(0, 3) : undefined}
              hasMore={!filters.favouritesOnly && !!results.hasNextPage}
              loadingMore={results.isFetchingNextPage}
              onLoadMore={() => {
                if (!results.isFetchingNextPage) void results.fetchNextPage()
              }}
            />
          )}
        </div>
      </div>
    </>
  )
}

function favouriteRow(f: Favourite): MarketProjectRow {
  return { key: f.key, platform: f.platform, id: f.id, slug: f.id, title: f.title, author: f.author, summary: f.summary, iconUrl: f.iconUrl, projectType: f.projectType, downloads: 0, followers: 0, categories: [], loaders: [], updatedAt: null, websiteUrl: '', linked: null, installed: false }
}

/** "Installing to: [Instance] · 1.21.1 Fabric ✕": the target instance, as an outlined chip in the tab row. */
function TargetBar({ target, instances }: { target: RuntimeInstanceRow; instances: RuntimeInstanceRow[] }) {
  const navigate = useNavigate({ from: '/discover/' })
  const options = instances.some((i) => i.id === target.id) ? instances : [target, ...instances]
  return (
    <div className="flex h-6 min-w-0 shrink items-center gap-1 rounded-md pr-0.5 pl-2 text-callout text-label-2 hairline-strong">
      <Box aria-hidden className="size-[13px] shrink-0" strokeWidth={1.5} />
      <span className="shrink-0">Installing to:</span>
      <Select
        aria-label="Target instance"
        variant="borderless"
        size="sm"
        value={target.id}
        onValueChange={(id) => navigate({ search: (s) => ({ ...s, target: id }) })}
        options={options.map((i) => ({ value: i.id, label: i.name, text: i.name }))}
        className="min-w-0 !pl-1 text-callout font-medium"
      />
      <span className="shrink-0 font-mono text-[11px] text-label-3 tabular">{runtimeLabel(target)}</span>
      <IconButton label="Clear target instance" size="sm" onClick={() => navigate({ search: (s) => ({ ...s, target: undefined }) })}>
        <X />
      </IconButton>
    </div>
  )
}

function FilterSidebar({ type, filters, setFilters, target, onClose }: { type: MarketProjectType; filters: Filters; setFilters: (f: Filters) => void; target?: RuntimeInstanceRow; onClose: () => void }) {
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch })
  const versions = useReleaseVersions()
  const categories = CATEGORIES[type] ?? []
  const loaderApplies = type === 'mod' || type === 'modpack'
  return (
    <aside id="discover-filters" aria-label="Filters" className="flex w-[200px] shrink-0 animate-enter flex-col gap-3.5 overflow-y-auto border-r border-separator px-3 pt-2 pb-4">
      <div className="-mr-1 flex h-7 items-center justify-between">
        <h2 className="text-meta font-semibold text-label-2">Filters</h2>
        <IconButton label="Hide Filters" size="sm" onClick={onClose}>
          <PanelLeftClose />
        </IconButton>
      </div>
      <FilterGroup label="Game version">
        <Select
          aria-label="Game version"
          value={filters.gameVersion === 'target' && !target ? 'any' : filters.gameVersion}
          onValueChange={(gameVersion) => set({ gameVersion })}
          className="w-full"
          options={[
            ...(target ? [{ value: 'target', label: `${target.minecraft} (target)`, text: target.minecraft }] : []),
            { value: 'any', label: 'Any' },
            ...(versions.data ?? ['1.21.4', '1.21.1', '1.20.1', '1.19.2', '1.18.2', '1.16.5', '1.12.2']).slice(0, 60).map((v) => ({ value: v, label: v })),
          ]}
        />
      </FilterGroup>
      {loaderApplies && (
        <FilterGroup label="Loader">
          <Select
            aria-label="Loader"
            value={filters.loader === 'target' && !(type === 'mod' && target?.loader) ? 'any' : filters.loader}
            onValueChange={(loader) => set({ loader })}
            className="w-full"
            options={[
              ...(type === 'mod' && target?.loader ? [{ value: 'target', label: `${LOADERS.find(([k]) => k === target.loader?.kind)?.[1]} (target)` }] : []),
              { value: 'any', label: 'Any' },
              ...LOADERS.map(([value, label]) => ({ value, label })),
            ]}
          />
        </FilterGroup>
      )}
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
          className="self-start"
        />
      </FilterGroup>
      {categories.length > 0 && (
        <FilterGroup label="Categories">
          <div className="flex flex-col gap-1">
            {categories.map(([value, label]) => (
              <Checkbox
                key={value}
                label={label}
                checked={filters.categories.includes(value)}
                onCheckedChange={(on) => set({ categories: on ? [...filters.categories, value] : filters.categories.filter((x) => x !== value) })}
              />
            ))}
          </div>
        </FilterGroup>
      )}
      <FilterGroup label="Show">
        <div className="flex flex-col gap-1">
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
      <span className="text-meta font-semibold text-label-3">{label}</span>
      {children}
    </div>
  )
}

const LIST_ROW = 52
const GRID_ROW = 146
type Item = MarketProjectRow | { more: true }
const isMore = (i: Item): i is { more: true } => 'more' in i

function Results({
  hits,
  view,
  target,
  heading,
  featured,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  hits: MarketProjectRow[]
  view: View
  target?: RuntimeInstanceRow
  heading: string
  featured?: MarketProjectRow[]
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
}) {
  const header = (
    <>
      {featured && featured.length > 0 && (
        <section aria-label="Featured" className="grid grid-cols-3 gap-3 px-4 pt-3.5">
          {featured.map((p) => (
            <FeaturedCard key={p.key} project={p} target={target} />
          ))}
        </section>
      )}
      <h2 className={cn('flex h-8 items-end px-4 pb-2 text-meta font-semibold text-label-2', featured?.length ? 'mt-3' : 'mt-1', view === 'list' && 'border-b border-separator')}>{heading}</h2>
    </>
  )
  const more = <LoadMore hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
  if (view === 'grid') {
    // Virtualise rows of three cards; card height is fixed so nothing is measured.
    const rows: Item[][] = []
    for (let i = 0; i < hits.length; i += 3) rows.push(hits.slice(i, i + 3))
    if (hasMore) rows.push([{ more: true }])
    return (
      <VirtualList
        items={rows}
        rowHeight={(r) => (r[0] && isMore(r[0]) ? 56 : GRID_ROW)}
        getKey={(r) => r.map((p) => (isMore(p) ? 'more' : p.key)).join()}
        aria-label="Results"
        header={header}
        paddingY={6}
        className="flex-1"
        renderRow={(row) =>
          row[0] && isMore(row[0]) ? (
            more
          ) : (
            <div className="grid h-full grid-cols-3 gap-3 px-4 pb-3 pt-0.5">
              {(row as MarketProjectRow[]).map((p) => (
                <GridCard key={p.key} project={p} target={target} />
              ))}
            </div>
          )
        }
      />
    )
  }
  const items: Item[] = hasMore ? [...hits, { more: true }] : hits
  return (
    <VirtualList
      items={items}
      rowHeight={(i) => (isMore(i) ? 56 : LIST_ROW)}
      getKey={(p) => (isMore(p) ? 'more' : p.key)}
      aria-label="Results"
      header={header}
      className="flex-1"
      renderRow={(p) => (isMore(p) ? more : <ListRow project={p} target={target} />)}
    />
  )
}

/** Infinite scroll: loads the next page when it scrolls into view, with a button as fallback. */
function LoadMore({ hasMore, loading, onLoadMore }: { hasMore: boolean; loading: boolean; onLoadMore: () => void }) {
  useEffect(() => {
    if (hasMore && !loading) onLoadMore()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per appearance
  }, [hasMore])
  return (
    <div className="flex h-full items-center justify-center">
      {loading ? (
        <Spinner label="Loading more results" />
      ) : (
        <Button size="md" onClick={onLoadMore}>
          Load More
        </Button>
      )}
    </div>
  )
}

const projectLink = (p: MarketProjectRow) => ({ to: '/discover/$projectId' as const, params: { projectId: p.key }, search: (s: Record<string, unknown>) => s })

/** Downloads and last update, as muted mono figures (with full values on hover). */
function Figures({ project, className }: { project: MarketProjectRow; className?: string }) {
  return (
    <span className={cn('flex shrink-0 items-baseline gap-3 font-mono text-[11px] text-label-3 tabular', className)}>
      {project.downloads > 0 && (
        <span title={`${project.downloads.toLocaleString('en')} downloads${project.followers > 0 ? ` · ${project.followers.toLocaleString('en')} followers` : ''}`} className="min-w-[44px] text-right">
          {formatCount(project.downloads)}
        </span>
      )}
      {project.updatedAt && (
        <span title={`Updated ${formatDate(Date.parse(project.updatedAt))}`} className="min-w-[62px] text-right">
          {shortAgo(Date.parse(project.updatedAt))}
        </span>
      )}
    </span>
  )
}

/** Compatibility with the target: loaders are known per result; versions were filtered by the search. */
function compatibleWith(project: MarketProjectRow, target?: RuntimeInstanceRow): boolean | undefined {
  if (!target || project.projectType !== 'mod' || project.loaders.length === 0) return undefined
  const kind = target.loader?.kind
  if (!kind) return false
  const ok = new Set([kind, ...(kind === 'quilt' ? ['fabric'] : []), ...(kind === 'neoforge' && target.minecraft === '1.20.1' ? ['forge'] : [])])
  return project.loaders.some((l) => ok.has(l))
}

function Compat({ project, target }: { project: MarketProjectRow; target?: RuntimeInstanceRow }) {
  const c = compatibleWith(project, target)
  if (c === undefined) return null
  // Compatible is the expected case (the search is already filtered to the target); only the exception speaks.
  return c ? (
    <span className="sr-only">Compatible</span>
  ) : (
    <span className="shrink-0 text-meta text-orange" title={`Not made for ${target?.loader?.kind ?? 'vanilla'}`}>
      Not compatible
    </span>
  )
}

/** One result: icon, title and author, summary, then source, figures, favourite and Install (the mockup's `.row.tall`). */
function ListRow({ project, target }: { project: MarketProjectRow; target?: RuntimeInstanceRow }) {
  return (
    <div className="flex h-full items-center gap-3 border-b border-separator pr-3 pl-4 hover:bg-hover">
      <ProjectIcon project={project} size={32} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <Link {...projectLink(project)} className="truncate text-body font-medium text-label hover:underline focus-visible:underline focus-visible:outline-none">
            {project.title}
          </Link>
          {project.author && <span className="truncate text-meta text-label-3">{project.author}</span>}
          <Compat project={project} target={target} />
        </div>
        <p className="mt-0.5 max-w-[560px] truncate text-callout text-label-2">{project.summary}</p>
      </div>
      <SourceBadge source={project.platform} />
      <Figures project={project} className="ml-2" />
      <FavouriteButton project={project} size="sm" />
      <InstallButton project={project} target={target} quiet compatible={compatibleWith(project, target) !== false} />
    </div>
  )
}

function GridCard({ project, target }: { project: MarketProjectRow; target?: RuntimeInstanceRow }) {
  return (
    <div className="relative flex h-full flex-col gap-2 rounded-[10px] border border-separator p-3 hover:bg-hover">
      <div className="flex items-start gap-2.5">
        <ProjectIcon project={project} size={32} />
        <div className="min-w-0 flex-1 leading-tight">
          <Link {...projectLink(project)} className="line-clamp-1 text-body font-medium after:absolute after:inset-0 hover:underline">
            {project.title}
          </Link>
          {project.author && <p className="truncate text-meta text-label-3">{project.author}</p>}
        </div>
        <span className="relative">
          <FavouriteButton project={project} size="sm" />
        </span>
      </div>
      <p className="line-clamp-2 text-callout text-label-2">{project.summary}</p>
      <div className="mt-auto flex items-center gap-2">
        <Figures project={project} className="[&>span]:min-w-0" />
        <Compat project={project} target={target} />
        <span className="relative ml-auto">
          <InstallButton project={project} target={target} quiet compatible={compatibleWith(project, target) !== false} />
        </span>
      </div>
    </div>
  )
}

/**
 * The landing page's three most popular projects: hairline cards with the real icon, no backdrop
 * art. The whole card opens the project; Install sits above the link.
 */
function FeaturedCard({ project, target }: { project: MarketProjectRow; target?: RuntimeInstanceRow }) {
  return (
    <div className="relative flex h-[124px] flex-col rounded-[10px] border border-separator p-3 transition-colors duration-150 hover:bg-hover has-[a:focus-visible]:bg-hover has-[a:focus-visible]:shadow-[inset_0_0_0_1.5px_var(--focus-ring)]">
      <div className="flex items-start gap-3">
        <ProjectIcon project={project} size={40} />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-meta text-label-3">Popular</p>
          <Link {...projectLink(project)} className="mt-0.5 block truncate text-headline font-semibold after:absolute after:inset-0 focus-visible:outline-none">
            {project.title}
          </Link>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-callout text-label-2">{project.summary}</p>
      <div className="mt-auto flex items-center justify-between">
        <Figures project={project} className="[&>span]:min-w-0" />
        <span className="relative">
          <InstallButton project={project} target={target} quiet />
        </span>
      </div>
    </div>
  )
}

function ResultsSkeleton({ view }: { view: View }) {
  return (
    <div role="status" aria-label="Loading results" className={cn('flex-1 overflow-hidden', view === 'grid' ? 'grid grid-cols-3 content-start gap-3 px-4 pt-4' : 'flex flex-col pt-9')}>
      {Array.from({ length: view === 'grid' ? 6 : 9 }, (_, i) =>
        view === 'grid' ? (
          <Skeleton key={i} className="h-[144px] rounded-[10px]" />
        ) : (
          <div key={i} className="flex h-[52px] items-center gap-3 border-b border-separator px-4">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-2.5 w-1/4" />
              <Skeleton className="h-2 w-1/2" />
            </div>
            <Skeleton className="h-[26px] w-16 rounded-[7px]" />
          </div>
        ),
      )}
    </div>
  )
}
