import { useMemo, useState } from 'react'
import { useNavigate, useParams, useRouter, useSearch } from '@tanstack/react-router'
import { ChevronDown, ChevronLeft, Copy, Download, ExternalLink, Heart, Play, SearchX } from 'lucide-react'
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Menu,
  Segmented,
  Select,
  Skeleton,
  Tabs,
  ToolbarTitle,
  VirtualList,
  cn,
  toast,
} from '@/ui'
import { useInstances } from '@/data/instances'
import { useProject } from '@/data/misc'
import type { ProjectDetail, ProjectVersion } from '@/data/types'
import { PageToolbar } from '@/app/PageToolbar'
import { QueryError } from '@/app/RouteStates'
import { notYetAvailable } from '@/app/commands'
import { ArtTile, BlockIcon, formatCount, formatDate, formatRelative } from '@/app/visuals'
import { FavouriteButton, InstallButton, SourceBadge, TYPE_LABELS } from './discover-parts'

type Tab = 'description' | 'versions' | 'gallery' | 'dependencies'

/** Project page (B5): pushed over Discover, with Back (⌘[). */
export function ProjectPage() {
  const { projectId } = useParams({ from: '/shell/discover/$projectId' })
  const search = useSearch({ from: '/shell/discover' })
  const router = useRouter()
  const navigate = useNavigate()
  const project = useProject(projectId)
  const { data: instances = [] } = useInstances()
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
            <ToolbarTitle title={p?.title ?? (project.isPending ? '' : 'Project')} subtitle={p ? TYPE_LABELS[p.type].one : undefined} />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {project.isPending ? (
          <ProjectSkeleton />
        ) : project.isError ? (
          <QueryError error={project.error} onRetry={() => project.refetch()} what="this project" />
        ) : !p ? (
          <EmptyState icon={<SearchX />} title="Project not found" description="It may have been removed from Modrinth or CurseForge." actions={<Button onClick={back}>Back to Discover</Button>} />
        ) : (
          <div className="mx-auto flex max-w-[960px] flex-col gap-5 px-8 pt-6 pb-10">
            <Header project={p} target={target} hasInstance={p.type === 'modpack' && p.installed === 'installed'} />
            <div className="flex gap-8">
              <div className="min-w-0 flex-1">
                <Tabs<Tab>
                  aria-label="Project sections"
                  value={tab}
                  onValueChange={setTab}
                  listClassName="!mx-0 mb-4 self-start"
                  tabs={[
                    { value: 'description', label: 'Description', content: <Description project={p} /> },
                    { value: 'versions', label: 'Versions', content: <Versions project={p} /> },
                    { value: 'gallery', label: 'Gallery', content: <Gallery project={p} /> },
                    { value: 'dependencies', label: 'Dependencies', content: <Dependencies project={p} /> },
                  ]}
                />
              </div>
              <SideColumn project={p} />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function Header({ project, target, hasInstance }: { project: ProjectDetail; target?: { name: string; minecraft: string } & Parameters<typeof InstallButton>[0]['target']; hasInstance: boolean }) {
  const supports = target ? project.versions.some((v) => v.gameVersions.includes(target.minecraft)) : true
  return (
    <header className="flex items-start gap-5">
      <BlockIcon hue={project.hue} label={project.title} size={88} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-title1 font-bold tracking-tight">{project.title}</h1>
          <FavouriteButton project={project} />
        </div>
        <p className="text-body text-label-2">
          by <span className="text-label">{project.author}</span>
        </p>
        <p className="mt-1.5 text-body text-label">{project.summary}</p>
        <div className="mt-2 flex items-center gap-3 text-small text-label-2">
          <SourceBadge source={project.source} />
          <span className="flex items-center gap-1 tabular">
            <Download className="size-3" /> {formatCount(project.downloads)} downloads
          </span>
          <span className="flex items-center gap-1 tabular">
            <Heart className="size-3" /> {formatCount(project.follows)} followers
          </span>
          <span>Updated {formatRelative(project.updatedAt)}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <div className="flex items-center gap-2">
          {hasInstance && (
            <Button size="lg" icon={<Play className="fill-current" />} onClick={() => notYetAvailable('Playing an installed modpack from Discover')}>
              Play
            </Button>
          )}
          <div className="flex">
            <InstallButton project={project} target={target} size="lg" />
            <Menu
              align="end"
              trigger={
                <button type="button" aria-label="More install options" className="ml-px flex h-7 w-6 items-center justify-center rounded-[7px] bg-control text-label shadow-control">
                  <ChevronDown className="size-3.5" />
                </button>
              }
              items={[{ label: 'Choose Version…', onSelect: () => notYetAvailable('Choosing a version') }]}
            />
          </div>
        </div>
        <p className={cn('max-w-[260px] text-right text-small', supports ? 'text-label-2' : 'text-orange')}>
          {supports
            ? project.type === 'modpack'
              ? hasInstance
                ? 'Installed as an instance'
                : 'Creates a new instance'
              : 'Installs 1 file + 2 required dependencies'
            : `No version supports ${target?.minecraft} (latest: ${project.versions[0]?.gameVersions[0]})`}
        </p>
      </div>
    </header>
  )
}

function Description({ project }: { project: ProjectDetail }) {
  // TODO(wire): render Markdown/HTML from the API with a lazily loaded renderer (kept out of the entry chunk).
  return (
    <article className="selectable max-w-[620px] text-body leading-[20px] whitespace-pre-line text-label">
      {project.body}
    </article>
  )
}

const channelTone = { release: 'success', beta: 'warning', alpha: 'error' } as const

function Versions({ project }: { project: ProjectDetail }) {
  const [channel, setChannel] = useState<'all' | ProjectVersion['channel']>('all')
  const [game, setGame] = useState('any')
  const versions = useMemo(
    () => project.versions.filter((v) => (channel === 'all' || v.channel === channel) && (game === 'any' || v.gameVersions.includes(game))),
    [project.versions, channel, game],
  )
  const games = [...new Set(project.versions.flatMap((v) => v.gameVersions))]
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Select aria-label="Game version" value={game} onValueChange={setGame} options={[{ value: 'any', label: 'All versions' }, ...games.map((g) => ({ value: g, label: g }))]} />
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
        <span className="ml-auto text-small text-label-2">{versions.length} versions</span>
      </div>
      {versions.length === 0 ? (
        <EmptyState title="No matching versions" className="py-8" />
      ) : (
        <VirtualList
          items={versions}
          rowHeight={44}
          getKey={(v) => v.id}
          aria-label="Versions"
          className="max-h-[440px] rounded-lg bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]"
          renderRow={(v) => (
            <div className="flex h-full items-center gap-3 border-b border-separator px-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-body font-medium">
                  {v.name}
                  <Badge tone={channelTone[v.channel]}>{v.channel}</Badge>
                </p>
                <p className="text-small text-label-2">
                  {v.gameVersions.join(', ')}
                  {v.loaders.length > 0 && ` · ${v.loaders.join(', ')}`} · {formatDate(v.publishedAt)}
                </p>
              </div>
              <span className="text-small text-label-2 tabular">{formatCount(v.downloads)}</span>
              <Button size="sm" onClick={() => toast({ kind: 'info', title: `Installing ${project.title} ${v.name}`, message: 'Progress is shown in Activity.' })}>
                Install
              </Button>
            </div>
          )}
        />
      )}
    </div>
  )
}

function Gallery({ project }: { project: ProjectDetail }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {project.gallery.map((g) => (
        <button
          key={g.id}
          type="button"
          aria-label={`Open ${g.title}`}
          onClick={() => notYetAvailable('The image viewer')}
          className="overflow-hidden rounded-lg shadow-card focus-visible:outline-3"
        >
          <ArtTile hue={g.hue} label={g.title} className="aspect-video w-full" />
        </button>
      ))}
    </div>
  )
}

function Dependencies({ project }: { project: ProjectDetail }) {
  if (project.type === 'modpack') return <EmptyState title="Modpacks list their contents after install" className="py-8" />
  return (
    <ul className="divide-y divide-separator overflow-hidden rounded-lg bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
      {[
        ['Fabric API', 'Required'],
        ['Cloth Config API', 'Required'],
        ['Mod Menu', 'Optional'],
      ].map(([name, kind]) => (
        <li key={name} className="flex h-11 items-center gap-3 px-3">
          <BlockIcon hue={name!.length * 30} label={name!} size={24} />
          <span className="flex-1 text-body">{name}</span>
          <Badge tone={kind === 'Required' ? 'accent' : 'neutral'}>{kind}</Badge>
        </li>
      ))}
    </ul>
  )
}

function SideColumn({ project }: { project: ProjectDetail }) {
  return (
    <aside aria-label="Details" className="flex w-[220px] shrink-0 flex-col gap-5">
      {project.alsoOn && (
        <section>
          <h3 className="mb-1.5 text-small font-semibold text-label-2">Source</h3>
          <Segmented
            aria-label="Source"
            size="sm"
            value={project.source}
            onValueChange={() => notYetAvailable('Switching sources')}
            options={[
              { value: 'modrinth', label: 'Modrinth' },
              { value: 'curseforge', label: 'CurseForge' },
            ]}
          />
        </section>
      )}
      <section>
        <h3 className="mb-1.5 text-small font-semibold text-label-2">Categories</h3>
        <div className="flex flex-wrap gap-1">
          {project.categories.map((c) => (
            <Badge key={c}>{c}</Badge>
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-1.5 text-small font-semibold text-label-2">Links</h3>
        <ul className="flex flex-col gap-1">
          {project.links.map((l) => (
            <li key={l.label}>
              <a href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-body text-accent hover:underline">
                {l.label} <ExternalLink className="size-3" />
              </a>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="mb-1.5 text-small font-semibold text-label-2">Technical</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
          <dt className="text-label-2">Licence</dt>
          <dd>{project.license}</dd>
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
