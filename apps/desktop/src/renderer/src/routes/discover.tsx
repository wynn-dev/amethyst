import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { AlertTriangle, Download, Heart, LayoutGrid, List, PanelLeftClose, PanelLeftOpen, SearchX, Star, Target, WifiOff, X } from 'lucide-react'
import type { MarketPlatform, MarketProjectRow, MarketProjectType, MarketSearchQuery } from '@shared/services'
import { Banner, Button, Checkbox, EmptyState, IconButton, SearchField, Segmented, Select, Skeleton, Spinner, ToolbarTitle, VirtualList, cn } from '@/ui'
import { useQuery } from '@tanstack/react-query'
import { PageToolbar } from '@/app/PageToolbar'
import { QueryError } from '@/app/RouteStates'
import { findTargetRef } from '@/app/ui-store'
import { formatCount, formatRelative } from '@/app/visuals'
import { useInstanceRows, runtimeLabel, type RuntimeInstanceRow } from '@/data/instance-info'
import { useFavourites, useMarketSearch, useMarketStatus, type Favourite } from '@/data/market'
import { api } from '@/lib/rpc'
import { errorMessage } from '@/lib/error-messages'
import { FavouriteButton, InstallButton, ProjectIcon, SourceBadge, TYPE_LABELS, eligible, hueOf } from './discover-parts'

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
  const [filtersOpen, setFiltersOpen] = useState(true)
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
  const clearFilters = () => setFilters(DEFAULT_FILTERS)
  const landing = !deferred && !filtered && !filters.favouritesOnly
  const totalLabel = results.data ? results.data.pages[0]?.total : undefined

  return (
    <>
      <PageToolbar
        leading={<ToolbarTitle title="Discover" />}
        trailing={
          <>
            <SearchField ref={findTargetRef} value={query} onValueChange={setQuery} placeholder={`Search ${TYPE_LABELS[type].many.toLowerCase()}`} className="w-[220px]" />
            <Select
              aria-label="Source"
              value={source}
              onValueChange={(v) => navigate({ search: (s) => ({ ...s, source: v === 'all' ? undefined : (v as MarketPlatform) }) })}
              options={[
                { value: 'all', label: 'All Sources' },
                { value: 'modrinth', label: 'Modrinth' },
                { value: 'curseforge', label: cfOff ? 'CurseForge (unavailable)' : 'CurseForge', text: 'CurseForge' },
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
          onValueChange={(t) => {
            setFilters((f) => ({ ...f, categories: [] }))
            navigate({ search: (s) => ({ ...s, type: t }) })
          }}
          options={(Object.keys(TYPE_LABELS) as MarketProjectType[]).map((t) => ({ value: t, label: TYPE_LABELS[t].many }))}
        />
      </div>
      {target && <TargetBar target={target} instances={eligible(instances, type === 'modpack' ? 'mod' : type)} />}
      <div className="flex min-h-0 flex-1">
        {filtersOpen && <FilterSidebar type={type} filters={filters} setFilters={setFilters} target={target} onClose={() => setFiltersOpen(false)} />}
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
            <p className="mx-4 mt-2.5 text-small text-label-2">CurseForge isn’t available in this build, so results come from Modrinth.</p>
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

function TargetBar({ target, instances }: { target: RuntimeInstanceRow; instances: RuntimeInstanceRow[] }) {
  const navigate = useNavigate({ from: '/discover/' })
  const options = instances.some((i) => i.id === target.id) ? instances : [target, ...instances]
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-separator bg-accent-soft px-4 py-1.5 text-body">
      <Target className="size-3.5 text-accent" />
      <span className="text-label-2">Installing to:</span>
      <Select
        aria-label="Target instance"
        variant="borderless"
        value={target.id}
        onValueChange={(id) => navigate({ search: (s) => ({ ...s, target: id }) })}
        options={options.map((i) => ({ value: i.id, label: i.name, text: i.name }))}
        className="font-medium"
      />
      <span className="text-label-2">· {runtimeLabel(target)}</span>
      <IconButton label="Clear target instance" size="sm" className="ml-auto" onClick={() => navigate({ search: (s) => ({ ...s, target: undefined }) })}>
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
    <aside aria-label="Filters" className="flex w-[208px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-separator bg-window-2 px-3 py-3">
      <div className="flex items-center justify-between">
        <h2 className="text-small font-semibold text-label-2">Filters</h2>
        <IconButton label="Hide Filters" size="sm" onClick={onClose}>
          <PanelLeftClose />
        </IconButton>
      </div>
      <FilterGroup label="Sort by">
        <Select
          aria-label="Sort by"
          value={filters.sort}
          onValueChange={(sort) => set({ sort: sort as Filters['sort'] })}
          className="w-full"
          options={[
            { value: 'auto', label: 'Relevance' },
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
        />
      </FilterGroup>
      {categories.length > 0 && (
        <FilterGroup label="Categories">
          <div className="flex flex-col gap-1.5">
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
        <section aria-label="Featured" className="grid grid-cols-3 gap-3 px-4 pt-4">
          {featured.map((p) => (
            <FeaturedCard key={p.key} project={p} target={target} />
          ))}
        </section>
      )}
      <h2 className="px-4 pt-4 pb-1 text-title3 font-semibold">{heading}</h2>
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
        rowHeight={(r) => (r[0] && isMore(r[0]) ? 56 : 196)}
        getKey={(r) => r.map((p) => (isMore(p) ? 'more' : p.key)).join()}
        aria-label="Results"
        header={header}
        paddingY={6}
        className="flex-1"
        renderRow={(row) =>
          row[0] && isMore(row[0]) ? (
            more
          ) : (
            <div className="grid h-full grid-cols-3 gap-3 px-4 pb-3">
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
      paddingY={4}
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

function Meta({ project }: { project: MarketProjectRow }) {
  return (
    <span className="flex items-center gap-2.5 text-small text-label-2">
      <SourceBadge source={project.platform} />
      {project.downloads > 0 && (
        <span className="flex items-center gap-1 tabular">
          <Download className="size-3" /> {formatCount(project.downloads)}
        </span>
      )}
      {project.followers > 0 && (
        <span className="flex items-center gap-1 tabular">
          <Heart className="size-3" /> {formatCount(project.followers)}
        </span>
      )}
      {project.updatedAt && <span>Updated {formatRelative(Date.parse(project.updatedAt))}</span>}
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
  return c ? (
    <span className="text-small font-medium text-green">Compatible</span>
  ) : (
    <span className="text-small font-medium text-orange" title={`Not made for ${target?.loader?.kind ?? 'vanilla'}`}>
      Not compatible
    </span>
  )
}

function ListRow({ project, target }: { project: MarketProjectRow; target?: RuntimeInstanceRow }) {
  return (
    <div className="mx-2 flex h-[80px] items-center gap-3 rounded-xl px-3 hover:bg-fill">
      <ProjectIcon project={project} size={52} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Link {...projectLink(project)} className="truncate text-body font-semibold text-label hover:underline focus-visible:underline focus-visible:outline-none">
            {project.title}
          </Link>
          {project.author && <span className="shrink-0 text-small text-label-2">by {project.author}</span>}
          <Compat project={project} target={target} />
        </div>
        <p className="truncate text-callout text-label-2">{project.summary}</p>
        <div className="mt-1">
          <Meta project={project} />
        </div>
      </div>
      <FavouriteButton project={project} size="sm" />
      <InstallButton project={project} target={target} compatible={compatibleWith(project, target) !== false} />
    </div>
  )
}

function GridCard({ project, target }: { project: MarketProjectRow; target?: RuntimeInstanceRow }) {
  return (
    <div className="flex h-full flex-col gap-2 rounded-xl bg-surface p-3 shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
      <div className="flex items-start gap-3">
        <ProjectIcon project={project} size={44} />
        <div className="min-w-0 flex-1">
          <Link {...projectLink(project)} className="line-clamp-1 text-body font-semibold hover:underline">
            {project.title}
          </Link>
          {project.author && <p className="truncate text-small text-label-2">by {project.author}</p>}
        </div>
        <FavouriteButton project={project} size="sm" />
      </div>
      <p className="line-clamp-2 flex-1 text-callout text-label-2">{project.summary}</p>
      <Meta project={project} />
      <div className="flex items-center justify-between">
        <Compat project={project} target={target} />
        <span className="ml-auto">
          <InstallButton project={project} target={target} size="sm" compatible={compatibleWith(project, target) !== false} />
        </span>
      </div>
    </div>
  )
}

function FeaturedCard({ project, target }: { project: MarketProjectRow; target?: RuntimeInstanceRow }) {
  const hue = hueOf(project.key)
  return (
    <div className="relative flex h-[132px] flex-col justify-end overflow-hidden rounded-xl p-3 text-white shadow-card">
      <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, hsl(${hue} 55% 48%), hsl(${(hue + 50) % 360} 60% 30%))` }} />
      {project.iconUrl && <img src={project.iconUrl} alt="" aria-hidden className="absolute -top-6 -right-6 size-36 rotate-12 rounded-3xl opacity-25 blur-[1px]" />}
      <div className="relative flex items-end gap-2.5">
        <ProjectIcon project={project} size={40} />
        <div className="min-w-0 flex-1">
          <p className="text-caption font-semibold tracking-[0.06em] text-white/70 uppercase">Popular</p>
          <Link {...projectLink(project)} className="block truncate text-title3 font-semibold after:absolute after:inset-0">
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
