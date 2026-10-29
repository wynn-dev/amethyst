import { lazy, Suspense, useMemo, useState } from 'react'
import { useNavigate, useParams, useRouter, useSearch } from '@tanstack/react-router'
import { ChevronDown, ChevronLeft, ChevronRight, Copy, ExternalLink, SearchX, X } from 'lucide-react'
import type { MarketProjectDetail, MarketVersionRow } from '@shared/services'
import { Button, EmptyState, IconButton, Menu, PanelDialog, Segmented, Select, Skeleton, Spinner, Tabs, ToolbarTitle, VirtualList, cn, toast } from '@/ui'
import { ChipGroup } from '@/ui/Chips'
import { PageToolbar } from '@/app/PageToolbar'
import { QueryError } from '@/app/RouteStates'
import { formatCount, formatDate } from '@/app/visuals'
import { useInstanceRows, runtimeLabel, type RuntimeInstanceRow } from '@/data/instance-info'
import { bestVersion, parseProjectKey, projectKey, useChangelog, useMarketProject, useMarketVersions } from '@/data/market'
import { openExternal } from '@/lib/files'
import { errorMessage } from '@/lib/error-messages'
import { FavouriteButton, InstallButton, ProjectIcon, TYPE_LABELS, shortAgo } from './discover-parts'
import { shortDate } from './instance/content-parts'

const Markdown = lazy(() => import('./markdown'))

type Tab = 'description' | 'versions' | 'gallery' | 'dependencies'
/** Pre-release channels are named in quiet status colour; releases need no label. */
const channelText = { release: 'text-label-3', beta: 'text-yellow', alpha: 'text-orange' } as const

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
          <div className="flex animate-enter flex-col gap-3.5 px-4 pt-3.5 pb-10">
            <Header project={p} target={target} onChooseVersion={() => setTab('versions')} />
            <div className="flex gap-6">
              <div className="min-w-0 flex-1">
                <Tabs<Tab>
                  aria-label="Project sections"
                  value={tab}
                  onValueChange={setTab}
                  listClassName="!mx-0 mb-4 -ml-2.5 self-start"
                  tabs={[
                    { value: 'description', label: 'Description', content: <Description project={p} /> },
                    { value: 'versions', label: 'Versions', content: <Versions project={p} target={target} /> },
                    {
                      value: 'gallery',
                      label: (
                        <span className="flex items-center gap-1.5">
                          Gallery{p.gallery.length > 0 && <span className="font-mono text-[10.5px] text-label-3 tabular">{p.gallery.length}</span>}
                        </span>
                      ),
                      content: <Gallery project={p} />,
                    },
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
    <header className="flex items-start gap-3.5 border-b border-separator pb-3.5">
      <ProjectIcon project={project} size={56} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <h1 className="truncate text-title2 font-semibold tracking-tight">{project.title}</h1>
          <FavouriteButton project={project} size="sm" />
        </div>
        <p className="mt-0.5 line-clamp-2 max-w-[680px] text-compact text-label-2">{project.summary}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-label-3">
          {project.author && (
            <span>
              by <span className="text-label-2">{project.author}</span>
            </span>
          )}
          <span title={`${project.downloads.toLocaleString('en')} downloads`}>
            <span className="font-mono text-[11px] text-label-2 tabular">{formatCount(project.downloads)}</span> downloads
          </span>
          <span title={`${project.followers.toLocaleString('en')} followers`}>
            <span className="font-mono text-[11px] text-label-2 tabular">{formatCount(project.followers)}</span> followers
          </span>
          {project.updatedAt && (
            <span title={formatDate(Date.parse(project.updatedAt))}>
              updated <span className="font-mono text-[11px] text-label-2 tabular">{shortAgo(Date.parse(project.updatedAt))}</span>
            </span>
          )}
          {project.linked ? (
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
          ) : (
            <span>{project.platform === 'modrinth' ? 'Modrinth' : 'CurseForge'}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <div className="flex">
          <InstallButton project={project} target={target} version={target && project.projectType !== 'modpack' ? best : undefined} compatible={!target || pending || !!best || project.projectType === 'modpack'} />
          <Menu
            align="end"
            trigger={
              <button type="button" aria-label="More install options" className="ml-1 flex size-[26px] items-center justify-center rounded-[7px] text-label-2 hairline-strong hover:bg-hover hover:text-label data-[state=open]:bg-fill">
                <ChevronDown className="size-3.5" />
              </button>
            }
            items={[
              { label: 'Choose Version…', onSelect: onChooseVersion },
              { label: `Open on ${project.platform === 'modrinth' ? 'Modrinth' : 'CurseForge'}`, onSelect: () => openExternal(project.websiteUrl) },
            ]}
          />
        </div>
        <p className={cn('max-w-[240px] text-right text-meta', target && !pending && !best && project.projectType !== 'modpack' ? 'text-orange' : 'text-label-3')}>{summary}</p>
      </div>
    </header>
  )
}

function Description({ project }: { project: MarketProjectDetail }) {
  return (
    <article className="max-w-[680px]">
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
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Select aria-label="Game version" variant="borderless" value={game} onValueChange={setGame} options={[{ value: 'any', label: 'All versions' }, ...games.map((g) => ({ value: g, label: g }))]} className="-ml-2.5" />
        {project.projectType === 'mod' && (
          <Select
            aria-label="Loader"
            variant="borderless"
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
        <ChipGroup
          aria-label="Channel"
          value={channel}
          onValueChange={setChannel}
          options={[
            { value: 'all', label: 'All' },
            { value: 'release', label: 'Release' },
            { value: 'beta', label: 'Beta' },
            { value: 'alpha', label: 'Alpha' },
          ]}
        />
      </div>
      {versions.isPending ? (
        <Spinner label="Loading versions" />
      ) : versions.isError ? (
        <QueryError error={new Error(errorMessage(versions.error))} onRetry={() => versions.refetch()} what="versions" />
      ) : list.length === 0 ? (
        <EmptyState title="No matching versions" description={game !== 'any' ? `Nothing for ${game}${loader !== 'any' ? ` with ${loader}` : ''}.` : undefined} className="py-8" />
      ) : (
        <section className="overflow-hidden rounded-[10px] border border-separator">
          <h3 className="flex h-8 items-center justify-between border-b border-separator px-3 text-meta font-semibold text-label-2">
            Versions <span className="font-mono text-[10.5px] font-normal text-label-3 tabular">{list.length}</span>
          </h3>
          {/* The list is size-contained, so it gets an explicit height: its rows, up to a cap. */}
          <div style={{ height: Math.min(540, list.length * 36 + (open && list.some((v) => v.id === open) ? 224 : 0)) }}>
            <VirtualList
              items={list}
              rowHeight={(v) => (v.id === open ? 260 : 36)}
              getKey={(v) => v.id}
              aria-label="Versions"
              className="h-full"
              renderRow={(v) => <VersionRow project={project} version={v} target={target} open={open === v.id} onToggle={() => setOpen(open === v.id ? null : v.id)} />}
            />
          </div>
        </section>
      )}
    </div>
  )
}

function VersionRow({ project, version: v, target, open, onToggle }: { project: MarketProjectDetail; version: MarketVersionRow; target?: RuntimeInstanceRow; open: boolean; onToggle: () => void }) {
  const log = useChangelog(project.platform, project.id, v.id, open)
  return (
    <div className="flex h-full flex-col border-b border-separator">
      <div className="flex h-9 shrink-0 items-center gap-2.5 pr-2 pl-1.5 hover:bg-hover">
        <button type="button" aria-expanded={open} aria-label={`Changelog of ${v.name}`} onClick={onToggle} className="flex size-5 items-center justify-center rounded text-label-3 hover:bg-fill hover:text-label-2">
          <ChevronRight className={cn('size-3.5 transition-transform duration-(--duration-spring) ease-spring', open && 'rotate-90')} />
        </button>
        <span className="min-w-0 flex-1 truncate mono text-label" title={v.name && v.name !== v.versionNumber ? `${v.versionNumber} · ${v.name}` : v.versionNumber}>
          {v.versionNumber}
          {v.manualDownloadRequired && <span className="ml-2 font-sans text-meta text-yellow">Manual download</span>}
        </span>
        {v.releaseType !== 'release' && <span className={cn('shrink-0 text-meta', channelText[v.releaseType])}>{v.releaseType}</span>}
        <span className="w-[96px] shrink-0 truncate text-meta text-label-3 capitalize">{v.loaders.join(', ')}</span>
        <span className="w-[112px] shrink-0 truncate text-right mono text-label-3" title={v.gameVersions.join(', ')}>
          {v.gameVersions.length > 2 ? `${v.gameVersions[0]} – ${v.gameVersions.at(-1)}` : v.gameVersions.join(', ')}
        </span>
        <span className="w-[60px] shrink-0 text-right mono text-label-3" title={formatDate(Date.parse(v.publishedAt))}>
          {shortDate(Date.parse(v.publishedAt))}
        </span>
        <span className="w-[44px] shrink-0 text-right mono text-label-3">{formatCount(v.downloads)}</span>
        <InstallButton project={project} target={target} size="sm" version={v} quiet />
      </div>
      {open && (
        <div className="min-h-0 flex-1 animate-enter overflow-y-auto border-t border-separator px-9 py-2.5">
          {log.isPending ? (
            <Spinner size={14} label="Loading changelog" />
          ) : log.isError ? (
            <p className="text-meta text-red">Couldn’t load the changelog.</p>
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
      <div className="grid max-w-[920px] grid-cols-2 gap-x-2.5 gap-y-3">
        {project.gallery.map((g, i) => (
          <button
            key={g.url}
            type="button"
            aria-label={`Open ${g.title ?? `image ${i + 1}`}`}
            onClick={() => setIndex(i)}
            className="relative overflow-hidden rounded-md bg-fill after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_0.5px_var(--color-separator-2)]"
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
              <span className="min-w-0 flex-1 truncate text-compact">{current.title ?? `Image ${(index ?? 0) + 1}`}</span>
              <span className="font-mono text-[11px] text-label-3 tabular">
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
const DEP_TEXT = { required: 'text-label-2', optional: 'text-label-3', incompatible: 'text-orange', embedded: 'text-label-3' } as const

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
    <section className="max-w-[680px] overflow-hidden rounded-[10px] border border-separator">
      <h3 className="flex h-8 items-center justify-between border-b border-separator px-3 text-meta font-semibold text-label-2">
        Dependencies <span className="truncate pl-3 font-mono text-[10.5px] font-normal text-label-3">{v.versionNumber}</span>
      </h3>
      <ul className="divide-y divide-separator">
        {deps.slice(0, 20).map((d) => (
          <DependencyRow key={`${d.projectId}:${d.type}`} platform={project.platform} projectId={d.projectId ?? ''} type={d.type} />
        ))}
      </ul>
    </section>
  )
}

function DependencyRow({ platform, projectId, type }: { platform: MarketProjectDetail['platform']; projectId: string; type: keyof typeof DEP_LABEL }) {
  const p = useMarketProject(platform, projectId)
  const navigate = useNavigate()
  return (
    <li>
      <button
        type="button"
        className="flex h-[38px] w-full items-center gap-2.5 px-3 text-left hover:bg-hover"
        onClick={() => navigate({ to: '/discover/$projectId', params: { projectId: projectKey(platform, projectId) }, search: (s) => s })}
      >
        {p.data ? <ProjectIcon project={p.data} size={20} /> : <Skeleton className="size-5 rounded-[5px]" />}
        <span className="flex-1 truncate text-compact font-medium">{p.data?.title ?? (p.isError ? projectId : '')}</span>
        <span className={cn('text-meta', DEP_TEXT[type])}>{DEP_LABEL[type]}</span>
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
  const head = 'mb-1.5 text-meta font-semibold text-label-3'
  return (
    <aside aria-label="Details" className="flex w-[220px] shrink-0 flex-col gap-4 pt-1">
      {project.categories.length > 0 && (
        <section>
          <h3 className={head}>Categories</h3>
          <p className="text-compact text-label-2 capitalize">{project.categories.join(' · ')}</p>
        </section>
      )}
      <section>
        <h3 className={head}>Links</h3>
        <ul className="flex flex-col gap-1">
          {links
            .filter((l): l is [string, string] => !!l[1] && /^https:\/\//i.test(l[1]))
            .map(([label, url]) => (
              <li key={label}>
                <button type="button" onClick={() => openExternal(url)} className="group flex items-center gap-1.5 text-compact text-label hover:underline">
                  {label} <ExternalLink className="size-3 text-label-3 group-hover:text-label-2" />
                </button>
              </li>
            ))}
        </ul>
      </section>
      <section>
        <h3 className={head}>Technical</h3>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-meta">
          <dt className="text-label-3">Licence</dt>
          <dd className="truncate text-label-2">{project.license || '—'}</dd>
          {project.loaders.length > 0 && (
            <>
              <dt className="text-label-3">Loaders</dt>
              <dd className="truncate text-label-2 capitalize">{project.loaders.join(', ')}</dd>
            </>
          )}
          {project.gameVersions.length > 0 && (
            <>
              <dt className="text-label-3">Minecraft</dt>
              <dd className="truncate font-mono text-[11px] text-label-2 tabular" title={project.gameVersions.join(', ')}>
                {project.gameVersions[0]}
                {project.gameVersions.length > 1 ? ` – ${project.gameVersions.at(-1)}` : ''}
              </dd>
            </>
          )}
          {project.createdAt && (
            <>
              <dt className="text-label-3">Published</dt>
              <dd className="font-mono text-[11px] text-label-2 tabular">{formatDate(Date.parse(project.createdAt))}</dd>
            </>
          )}
          <dt className="text-label-3">Project ID</dt>
          <dd className="-my-1 flex min-w-0 items-center gap-1">
            <span className="selectable truncate font-mono text-[11px] text-label-2">{project.id}</span>
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
    <div role="status" aria-label="Loading project" className="flex flex-col gap-3.5 px-4 pt-3.5">
      <div className="flex gap-3.5 border-b border-separator pb-3.5">
        <Skeleton className="size-14 rounded-[14px]" />
        <div className="flex flex-1 flex-col gap-2 pt-1">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-2.5 w-1/2" />
          <Skeleton className="h-2.5 w-1/3" />
        </div>
      </div>
      <Skeleton className="h-5 w-72 rounded-md" />
      <Skeleton className="h-40 max-w-[680px]" />
    </div>
  )
}
