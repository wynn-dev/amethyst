import { lazy, Suspense, useMemo, useState } from 'react'
import { useNavigate, useParams, useRouter, useSearch } from '@tanstack/react-router'
import { ChevronDown, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, Heart, SearchX, X } from 'lucide-react'
import type { MarketProjectDetail, MarketVersionRow } from '@shared/services'
import { Badge, Button, EmptyState, IconButton, Menu, PanelDialog, Segmented, Select, Skeleton, Spinner, Tabs, ToolbarTitle, VirtualList, cn, toast } from '@/ui'
import { PageToolbar } from '@/app/PageToolbar'
import { QueryError } from '@/app/RouteStates'
import { formatCount, formatDate, formatRelative } from '@/app/visuals'
import { useInstanceRows, runtimeLabel, type RuntimeInstanceRow } from '@/data/instance-info'
import { bestVersion, parseProjectKey, projectKey, useChangelog, useMarketProject, useMarketVersions } from '@/data/market'
import { openExternal } from '@/lib/files'
import { errorMessage } from '@/lib/error-text'
import { FavouriteButton, InstallButton, ProjectIcon, SourceBadge, TYPE_LABELS } from './discover-parts'

const Markdown = lazy(() => import('./markdown'))

type Tab = 'description' | 'versions' | 'gallery' | 'dependencies'
const channelTone = { release: 'success', beta: 'warning', alpha: 'error' } as const

/** Project page (B5): pushed over Discover, with Back (⌘[). */
export function ProjectPage() {
  const { projectId } = useParams({ from: '/shell/discover/$projectId' })
  const search = useSearch({ from: '/shell/discover' })
  const router = useRouter()
  const navigate = useNavigate()
  const ref = parseProjectKey(projectId)
  const project = useMarketProject(ref?.platform, ref?.id)
  const { data: instances = [] } = useInstanceRows()
  const target = instances.find((i) => i.id === search.target)
  const [tab, setTab] = useState<Tab>('description')

  const back = () => (router.history.length > 1 ? router.history.back() : navigate({ to: '/discover', search }))

  const p = project.data
  return (
    <>
      <PageToolbar
        leading={
          <>
            <IconButton label="Back" shortcut="mod+[" onClick={back}>
              <ChevronLeft />
            </IconButton>
            <ToolbarTitle title={p?.title ?? (project.isPending ? '' : 'Project')} subtitle={p?.projectType ? TYPE_LABELS[p.projectType].one : undefined} />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!ref ? (
          <EmptyState icon={<SearchX />} title="Project not found" description="This link doesn’t point to a Modrinth or CurseForge project." actions={<Button onClick={back}>Back to Discover</Button>} />
        ) : project.isPending ? (
          <ProjectSkeleton />
        ) : project.isError ? (
          (project.error as { code?: string }).code === 'ENOT_FOUND' ? (
            <EmptyState icon={<SearchX />} title="Project not found" description="It may have been removed from Modrinth or CurseForge." actions={<Button onClick={back}>Back to Discover</Button>} />
          ) : (
            <QueryError error={new Error(errorMessage(project.error))} onRetry={() => project.refetch()} what="this project" />
          )
        ) : p ? (
          <div className="mx-auto flex max-w-[960px] flex-col gap-5 px-8 pt-6 pb-10">
            <Header project={p} target={target} onChooseVersion={() => setTab('versions')} />
            <div className="flex gap-8">
              <div className="min-w-0 flex-1">
                <Tabs<Tab>
                  aria-label="Project sections"
                  value={tab}
                  onValueChange={setTab}
                  listClassName="!mx-0 mb-4 self-start"
                  tabs={[
                    { value: 'description', label: 'Description', content: <Description project={p} /> },
                    { value: 'versions', label: 'Versions', content: <Versions project={p} target={target} /> },
                    { value: 'gallery', label: `Gallery${p.gallery.length ? ` (${p.gallery.length})` : ''}`, content: <Gallery project={p} /> },
                    { value: 'dependencies', label: 'Dependencies', content: <Dependencies project={p} target={target} /> },
                  ]}
                />
              </div>
              <SideColumn project={p} />
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}

/** The version the primary Install would pick for the target (or the newest overall). */
function useBestVersion(project: MarketProjectDetail, target?: RuntimeInstanceRow) {
  const loader = project.projectType === 'mod' ? target?.loader?.kind : undefined
  const forTarget = useMarketVersions(project.platform, project.id, { ...(target ? { gameVersion: target.minecraft } : {}), ...(loader ? { loader } : {}) }, !!target && project.projectType !== 'modpack')
  return { best: forTarget.data ? bestVersion(forTarget.data) : undefined, pending: forTarget.isPending && !!target && project.projectType !== 'modpack' }
}

function Header({ project, target, onChooseVersion }: { project: MarketProjectDetail; target?: RuntimeInstanceRow; onChooseVersion: () => void }) {
  const { best, pending } = useBestVersion(project, target)
  const required = best?.dependencies.filter((d) => d.type === 'required').length ?? 0
  const navigate = useNavigate()
  const summary =
    project.projectType === 'modpack'
      ? 'Creates a new instance'
      : !target
        ? 'Choose an instance to install into'
        : pending
          ? 'Checking versions…'
          : best
            ? `Installs 1 file${required ? ` + ${required} required ${required === 1 ? 'dependency' : 'dependencies'}` : ''} into “${target.name}”`
            : `No version supports ${runtimeLabel(target)}${project.gameVersions[0] ? ` (latest: ${project.gameVersions.at(-1)})` : ''}`
  return (
    <header className="flex items-start gap-5">
      <ProjectIcon project={project} size={88} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-title1 font-bold tracking-tight">{project.title}</h1>
          <FavouriteButton project={project} />
        </div>
        {project.author && (
          <p className="text-body text-label-2">
            by <span className="text-label">{project.author}</span>
          </p>
        )}
        <p className="mt-1.5 text-body text-label">{project.summary}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-small text-label-2">
          <SourceBadge source={project.platform} />
          <span className="flex items-center gap-1 tabular">
            <Download className="size-3" /> {formatCount(project.downloads)} downloads
          </span>
          <span className="flex items-center gap-1 tabular">
            <Heart className="size-3" /> {formatCount(project.followers)} followers
          </span>
          {project.updatedAt && <span>Updated {formatRelative(Date.parse(project.updatedAt))}</span>}
          {project.linked && (
            <Segmented
              aria-label="Source"
              size="sm"
              value={project.platform}
              onValueChange={(platform) => {
                const id = platform === project.linked?.platform ? project.linked.id : project.id
                navigate({ to: '/discover/$projectId', params: { projectId: projectKey(platform, id) }, search: (s) => s, replace: true })
              }}
              options={[
                { value: 'modrinth', label: 'Modrinth' },
                { value: 'curseforge', label: 'CurseForge' },
              ]}
            />
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <div className="flex">
          <InstallButton project={project} target={target} size="lg" version={target && project.projectType !== 'modpack' ? best : undefined} compatible={!target || pending || !!best || project.projectType === 'modpack'} />
          <Menu
            align="end"
            trigger={
              <button type="button" aria-label="More install options" className="ml-px flex h-7 w-6 items-center justify-center rounded-[7px] bg-control text-label shadow-control">
                <ChevronDown className="size-3.5" />
              </button>
            }
            items={[
              { label: 'Choose Version…', onSelect: onChooseVersion },
              { label: `Open on ${project.platform === 'modrinth' ? 'Modrinth' : 'CurseForge'}`, onSelect: () => openExternal(project.websiteUrl) },
            ]}
          />
        </div>
        <p className={cn('max-w-[260px] text-right text-small', target && !pending && !best && project.projectType !== 'modpack' ? 'text-orange' : 'text-label-2')}>{summary}</p>
      </div>
    </header>
  )
}

function Description({ project }: { project: MarketProjectDetail }) {
  return (
    <article className="max-w-[640px]">
      <Suspense fallback={<Spinner label="Loading description" />}>
        <Markdown source={project.body || project.summary} format={project.bodyFormat} />
      </Suspense>
    </article>
  )
}

function Versions({ project, target }: { project: MarketProjectDetail; target?: RuntimeInstanceRow }) {
  const [channel, setChannel] = useState<'all' | MarketVersionRow['releaseType']>('all')
  const [game, setGame] = useState(target?.minecraft ?? 'any')
  const [loader, setLoader] = useState(project.projectType === 'mod' && target?.loader ? target.loader.kind : 'any')
  const versions = useMarketVersions(project.platform, project.id, { ...(game !== 'any' ? { gameVersion: game } : {}), ...(loader !== 'any' ? { loader } : {}) })
  const list = useMemo(() => (versions.data ?? []).filter((v) => channel === 'all' || v.releaseType === channel), [versions.data, channel])
  const games = project.gameVersions.toReversed()
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Game version" value={game} onValueChange={setGame} options={[{ value: 'any', label: 'All versions' }, ...games.map((g) => ({ value: g, label: g }))]} />
        {project.projectType === 'mod' && (
          <Select
            aria-label="Loader"
            value={loader}
            onValueChange={setLoader}
            options={[
              { value: 'any', label: 'All loaders' },
              { value: 'fabric', label: 'Fabric' },
              { value: 'quilt', label: 'Quilt' },
              { value: 'forge', label: 'Forge' },
              { value: 'neoforge', label: 'NeoForge' },
            ]}
          />
        )}
        <Segmented
          aria-label="Channel"
          value={channel}
          onValueChange={setChannel}
          size="sm"
          options={[
            { value: 'all', label: 'All' },
            { value: 'release', label: 'Release' },
            { value: 'beta', label: 'Beta' },
            { value: 'alpha', label: 'Alpha' },
          ]}
        />
        <span className="ml-auto text-small text-label-2">{versions.isPending ? '' : `${list.length} versions`}</span>
      </div>
      {versions.isPending ? (
        <Spinner label="Loading versions" />
      ) : versions.isError ? (
        <QueryError error={new Error(errorMessage(versions.error))} onRetry={() => versions.refetch()} what="versions" />
      ) : list.length === 0 ? (
        <EmptyState title="No matching versions" description={game !== 'any' ? `Nothing for ${game}${loader !== 'any' ? ` with ${loader}` : ''}.` : undefined} className="py-8" />
      ) : (
        <VirtualList
          items={list}
          rowHeight={(v) => (v.id === open ? 260 : 48)}
          getKey={(v) => v.id}
          aria-label="Versions"
          className="max-h-[480px] rounded-lg bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]"
          renderRow={(v) => <VersionRow project={project} version={v} target={target} open={open === v.id} onToggle={() => setOpen(open === v.id ? null : v.id)} />}
        />
      )}
    </div>
  )
}

function VersionRow({ project, version: v, target, open, onToggle }: { project: MarketProjectDetail; version: MarketVersionRow; target?: RuntimeInstanceRow; open: boolean; onToggle: () => void }) {
  const log = useChangelog(project.platform, project.id, v.id, open)
  return (
    <div className="flex h-full flex-col border-b border-separator">
      <div className="flex h-12 shrink-0 items-center gap-3 px-3">
        <button type="button" aria-expanded={open} aria-label={`Changelog of ${v.name}`} onClick={onToggle} className="flex size-5 items-center justify-center rounded text-label-2 hover:bg-fill">
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-body font-medium">
            <span className="truncate">{v.name || v.versionNumber}</span>
            <Badge tone={channelTone[v.releaseType]}>{v.releaseType}</Badge>
            {v.manualDownloadRequired && <Badge tone="warning">Manual download</Badge>}
          </p>
          <p className="truncate text-small text-label-2">
            {v.gameVersions.slice(0, 6).join(', ')}
            {v.gameVersions.length > 6 && '…'}
            {v.loaders.length > 0 && ` · ${v.loaders.join(', ')}`} · {formatDate(Date.parse(v.publishedAt))}
          </p>
        </div>
        <span className="text-small text-label-2 tabular">{formatCount(v.downloads)}</span>
        <InstallButton project={project} target={target} size="sm" version={v} />
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto px-10 pb-3">
          {log.isPending ? (
            <Spinner size={14} label="Loading changelog" />
          ) : log.isError ? (
            <p className="text-small text-red">Couldn’t load the changelog.</p>
          ) : (
            <Suspense fallback={<Spinner size={14} label="Loading" />}>
              <Markdown source={log.data || 'No changelog.'} format={project.platform === 'curseforge' ? 'html' : 'markdown'} />
            </Suspense>
          )}
        </div>
      )}
    </div>
  )
}

function Gallery({ project }: { project: MarketProjectDetail }) {
  const [index, setIndex] = useState<number | null>(null)
  if (project.gallery.length === 0) return <EmptyState title="No images" className="py-8" />
  const current = index === null ? undefined : project.gallery[index]
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        {project.gallery.map((g, i) => (
          <button
            key={g.url}
            type="button"
            aria-label={`Open ${g.title ?? `image ${i + 1}`}`}
            onClick={() => setIndex(i)}
            className="overflow-hidden rounded-lg bg-fill shadow-card focus-visible:outline-3"
          >
            <img src={g.url} alt={g.title ?? ''} loading="lazy" decoding="async" className="aspect-video w-full object-cover" />
          </button>
        ))}
      </div>
      <PanelDialog open={index !== null} onOpenChange={(o) => !o && setIndex(null)} title={current?.title ?? 'Image'} width={1000} top="6vh">
        {current && (
          <div
            className="relative bg-black"
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') setIndex((i) => (i === null ? i : (i + 1) % project.gallery.length))
              if (e.key === 'ArrowLeft') setIndex((i) => (i === null ? i : (i - 1 + project.gallery.length) % project.gallery.length))
            }}
          >
            <img src={current.url} alt={current.title ?? ''} className="max-h-[78vh] w-full object-contain" />
            <div className="flex items-center gap-2 bg-raised px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-body">{current.title ?? `Image ${(index ?? 0) + 1}`}</span>
              <span className="text-small text-label-2 tabular">
                {(index ?? 0) + 1} / {project.gallery.length}
              </span>
              <IconButton label="Previous image" size="sm" onClick={() => setIndex((i) => (i === null ? i : (i - 1 + project.gallery.length) % project.gallery.length))}>
                <ChevronLeft />
              </IconButton>
              <IconButton label="Next image" size="sm" onClick={() => setIndex((i) => (i === null ? i : (i + 1) % project.gallery.length))}>
                <ChevronRight />
              </IconButton>
              <IconButton label="Close" size="sm" onClick={() => setIndex(null)}>
                <X />
              </IconButton>
            </div>
          </div>
        )}
      </PanelDialog>
    </>
  )
}

const DEP_LABEL = { required: 'Required', optional: 'Optional', incompatible: 'Incompatible', embedded: 'Embedded' } as const
const DEP_TONE = { required: 'accent', optional: 'neutral', incompatible: 'error', embedded: 'neutral' } as const

function Dependencies({ project, target }: { project: MarketProjectDetail; target?: RuntimeInstanceRow }) {
  const loader = project.projectType === 'mod' ? target?.loader?.kind : undefined
  const versions = useMarketVersions(project.platform, project.id, { ...(target ? { gameVersion: target.minecraft } : {}), ...(loader ? { loader } : {}) })
  if (project.projectType === 'modpack') return <EmptyState title="Modpacks list their contents after install" className="py-8" />
  if (versions.isPending) return <Spinner label="Loading dependencies" />
  if (versions.isError) return <QueryError error={new Error(errorMessage(versions.error))} onRetry={() => versions.refetch()} what="dependencies" />
  const v = versions.data ? bestVersion(versions.data) : undefined
  const deps = (v?.dependencies ?? []).filter((d) => d.projectId)
  if (!v) return <EmptyState title={target ? `No version for ${runtimeLabel(target)}` : 'No versions'} className="py-8" />
  if (deps.length === 0) return <EmptyState title="No dependencies" description={`${v.name || v.versionNumber} works on its own.`} className="py-8" />
  return (
    <div className="flex flex-col gap-2">
      <p className="text-small text-label-2">For {v.name || v.versionNumber}</p>
      <ul className="divide-y divide-separator overflow-hidden rounded-lg bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
        {deps.slice(0, 20).map((d) => (
          <DependencyRow key={`${d.projectId}:${d.type}`} platform={project.platform} projectId={d.projectId ?? ''} type={d.type} />
        ))}
      </ul>
    </div>
  )
}

function DependencyRow({ platform, projectId, type }: { platform: MarketProjectDetail['platform']; projectId: string; type: keyof typeof DEP_LABEL }) {
  const p = useMarketProject(platform, projectId)
  const navigate = useNavigate()
  return (
    <li>
      <button
        type="button"
        className="flex h-11 w-full items-center gap-3 px-3 text-left hover:bg-fill"
        onClick={() => navigate({ to: '/discover/$projectId', params: { projectId: projectKey(platform, projectId) }, search: (s) => s })}
      >
        {p.data ? <ProjectIcon project={p.data} size={24} /> : <Skeleton className="size-6 rounded-md" />}
        <span className="flex-1 truncate text-body">{p.data?.title ?? (p.isError ? projectId : '')}</span>
        <Badge tone={DEP_TONE[type]}>{DEP_LABEL[type]}</Badge>
      </button>
    </li>
  )
}

function SideColumn({ project }: { project: MarketProjectDetail }) {
  const links: [string, string | undefined][] = [
    [project.platform === 'modrinth' ? 'Modrinth page' : 'CurseForge page', project.websiteUrl],
    ['Issues', project.links.issues],
    ['Source code', project.links.source],
    ['Wiki', project.links.wiki],
    ['Discord', project.links.discord],
  ]
  return (
    <aside aria-label="Details" className="flex w-[220px] shrink-0 flex-col gap-5">
      {project.categories.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-small font-semibold text-label-2">Categories</h3>
          <div className="flex flex-wrap gap-1">
            {project.categories.map((c) => (
              <Badge key={c}>{c}</Badge>
            ))}
          </div>
        </section>
      )}
      <section>
        <h3 className="mb-1.5 text-small font-semibold text-label-2">Links</h3>
        <ul className="flex flex-col gap-1">
          {links
            .filter((l): l is [string, string] => !!l[1] && /^https:\/\//i.test(l[1]))
            .map(([label, url]) => (
              <li key={label}>
                <button type="button" onClick={() => openExternal(url)} className="flex items-center gap-1.5 text-body text-accent hover:underline">
                  {label} <ExternalLink className="size-3" />
                </button>
              </li>
            ))}
        </ul>
      </section>
      <section>
        <h3 className="mb-1.5 text-small font-semibold text-label-2">Technical</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
          <dt className="text-label-2">Licence</dt>
          <dd className="truncate">{project.license ?? '—'}</dd>
          {project.loaders.length > 0 && (
            <>
              <dt className="text-label-2">Loaders</dt>
              <dd className="truncate">{project.loaders.join(', ')}</dd>
            </>
          )}
          {project.gameVersions.length > 0 && (
            <>
              <dt className="text-label-2">Minecraft</dt>
              <dd className="truncate" title={project.gameVersions.join(', ')}>
                {project.gameVersions[0]}
                {project.gameVersions.length > 1 ? ` – ${project.gameVersions.at(-1)}` : ''}
              </dd>
            </>
          )}
          {project.createdAt && (
            <>
              <dt className="text-label-2">Published</dt>
              <dd>{formatDate(Date.parse(project.createdAt))}</dd>
            </>
          )}
          <dt className="text-label-2">Project ID</dt>
          <dd className="flex items-center gap-1">
            <span className="selectable truncate font-mono">{project.id}</span>
            <IconButton
              label="Copy project ID"
              size="sm"
              onClick={() => {
                navigator.clipboard?.writeText(project.id)
                toast({ kind: 'success', title: 'Copied project ID' })
              }}
            >
              <Copy />
            </IconButton>
          </dd>
        </dl>
      </section>
    </aside>
  )
}

function ProjectSkeleton() {
  return (
    <div role="status" aria-label="Loading project" className="mx-auto flex max-w-[960px] flex-col gap-5 px-8 pt-6">
      <div className="flex gap-5">
        <Skeleton className="size-[88px] rounded-2xl" />
        <div className="flex flex-1 flex-col gap-2 pt-1">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-3 w-1/5" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
      <Skeleton className="h-6 w-80 rounded-md" />
      <Skeleton className="h-40" />
    </div>
  )
}
