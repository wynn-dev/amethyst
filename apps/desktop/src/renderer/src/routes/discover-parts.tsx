import { useState } from 'react'
import { Check, Download, RotateCcw, Star } from 'lucide-react'
import type { MarketPlatform, MarketProjectRow, MarketProjectType, MarketVersionRow } from '@shared/services'
import { Badge, Button, Menu, ProgressRing, cn, type MenuEntry } from '@/ui'
import { openInstance } from '@/app/commands'
import { BlockIcon } from '@/app/visuals'
import { useInstanceRows, runtimeLabel, type RuntimeInstanceRow } from '@/data/instance-info'
import { KIND_FOR_TYPE, bestVersion, installProject, projectKey, useFavourites, useInstallState, type InstallTarget } from '@/data/market'
import { installModpackFromMarket } from '@/data/modpacks'
import { useRunningTask } from '@/data/tasks'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'

export const TYPE_LABELS: Record<MarketProjectType, { one: string; many: string }> = {
  modpack: { one: 'Modpack', many: 'Modpacks' },
  mod: { one: 'Mod', many: 'Mods' },
  resourcepack: { one: 'Resource Pack', many: 'Resource Packs' },
  shader: { one: 'Shader', many: 'Shaders' },
  datapack: { one: 'Data Pack', many: 'Data Packs' },
  world: { one: 'World', many: 'Worlds' },
}

/** Instance tab that shows a project type's files. */
export const TAB_FOR_TYPE: Partial<Record<MarketProjectType, 'mods' | 'resource-packs' | 'shaders' | 'worlds'>> = { mod: 'mods', resourcepack: 'resource-packs', shader: 'shaders', world: 'worlds' }

export function SourceBadge({ source }: { source: MarketPlatform }) {
  return source === 'modrinth' ? <Badge tone="success">Modrinth</Badge> : <Badge tone="warning">CurseForge</Badge>
}

export function hueOf(s: string): number {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

export function ProjectIcon({ project, size }: { project: Pick<MarketProjectRow, 'key' | 'title' | 'iconUrl'>; size: number }) {
  return <BlockIcon hue={hueOf(project.key)} label={project.title} size={size} src={project.iconUrl ?? undefined} className="bg-fill" />
}

/** Instances a project type can go into (mods need a loader). */
export function eligible(instances: RuntimeInstanceRow[], type: MarketProjectType | null): RuntimeInstanceRow[] {
  return instances.filter((i) => i.state === 'ok' && (type !== 'mod' || i.loader !== null))
}

export const toTarget = (i: RuntimeInstanceRow): InstallTarget => ({ id: i.id, name: i.name, minecraft: i.minecraft, loader: i.loader })

export function FavouriteButton({ project, size = 'md' }: { project: Pick<MarketProjectRow, 'key' | 'platform' | 'id' | 'title' | 'author' | 'summary' | 'iconUrl' | 'projectType'>; size?: 'sm' | 'md' }) {
  const on = useFavourites((s) => !!s.items[project.key])
  const toggle = useFavourites((s) => s.toggle)
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Remove ${project.title} from Favourites` : `Add ${project.title} to Favourites`}
      title={on ? 'Remove from Favourites' : 'Add to Favourites'}
      onClick={() => toggle({ key: project.key, platform: project.platform, id: project.id, title: project.title, author: project.author, summary: project.summary, iconUrl: project.iconUrl, projectType: project.projectType })}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md hover:bg-fill',
        size === 'md' ? 'size-7 [&_svg]:size-4' : 'size-6 [&_svg]:size-3.5',
        on ? 'text-yellow' : 'text-label-3 hover:text-label-2',
      )}
    >
      <Star className={cn(on && 'fill-current')} />
    </button>
  )
}

/** Install a modpack as a new instance: the newest release (or the version given). */
export async function installModpackProject(project: Pick<MarketProjectRow, 'platform' | 'id' | 'title'>, version?: MarketVersionRow): Promise<void> {
  try {
    const v = version ?? bestVersion(await api.marketplace.getVersions(project.platform, project.id))
    if (!v) throw Object.assign(new Error(`${project.title} has no downloadable version.`), { code: 'ENO_FILE' })
    await installModpackFromMarket({ platform: project.platform, projectId: project.id, versionId: v.id }, project.title, (id) => openInstance(id, 'overview'))
  } catch (e) {
    toastError(e, `Couldn’t install “${project.title}”`)
  }
}

type Project = Pick<MarketProjectRow, 'key' | 'platform' | 'id' | 'title' | 'projectType' | 'installed'>

/**
 * Install button: Install → progress → Installed ✓ (B5). With a target instance it installs
 * there; without one it asks which instance; modpacks create a new instance.
 */
export function InstallButton({ project, target, size = 'md', version, compatible = true }: { project: Project; target?: RuntimeInstanceRow; size?: 'sm' | 'md' | 'lg'; version?: MarketVersionRow; compatible?: boolean }) {
  const { data: instances = [] } = useInstanceRows()
  const state = useInstallState(target?.id, project.key)
  const [modpackBusy, setModpackBusy] = useState(false)
  const task = useRunningTask((t) => (t.name === 'market.install' || t.name === 'modpack.import') && String(t.params.title ?? t.params.name ?? '') === project.title)
  const label = `${project.title}`

  if (project.projectType === 'datapack')
    return (
      <Button size={size} disabled title="Data packs go into a world; installing them from Discover isn’t available yet. Download it from the project page and add it to the world’s datapacks folder.">
        <Download /> Install
      </Button>
    )

  if (state?.state === 'installing' || modpackBusy)
    return (
      <Button size={size} disabled aria-label={`Installing ${label}`}>
        <ProgressRing size={13} value={task && task.fraction > 0 ? task.fraction : undefined} /> {task && task.fraction > 0 ? `${Math.round(task.fraction * 100)}%` : 'Installing'}
      </Button>
    )

  if (project.projectType === 'modpack')
    return (
      <Button
        size={size}
        variant="primary"
        icon={<Download />}
        onClick={async () => {
          setModpackBusy(true)
          await installModpackProject(project, version)
          setModpackBusy(false)
        }}
      >
        Install
      </Button>
    )

  const installed = state?.state === 'installed' || (!!target && project.installed && !version)
  if (installed && target)
    return (
      <Button size={size} variant="borderless" className="text-label-2" onClick={() => openInstance(target.id, TAB_FOR_TYPE[project.projectType ?? 'mod'] ?? 'mods')} title={`Show in “${target.name}”`}>
        <Check className="text-green" /> Installed
      </Button>
    )

  if (target)
    return (
      <Button
        size={size}
        variant={state?.state === 'failed' ? 'push' : 'primary'}
        icon={state?.state === 'failed' ? <RotateCcw /> : <Download />}
        disabled={!compatible || !KIND_FOR_TYPE[project.projectType ?? 'mod']}
        title={!compatible ? `No version supports ${runtimeLabel(target)}` : state?.state === 'failed' ? state.message : undefined}
        onClick={() => void installProject(project, toTarget(target), version)}
      >
        {state?.state === 'failed' ? 'Retry' : 'Install'}
      </Button>
    )

  // No target: ask which instance (labels over icons, a click menu, never hover).
  const choices = eligible(instances, project.projectType)
  const items: MenuEntry[] = choices.length
    ? [{ kind: 'label', label: 'Install to' }, ...choices.map<MenuEntry>((i) => ({ label: `${i.name} (${runtimeLabel(i)})`, onSelect: () => void installProject(project, toTarget(i), version) }))]
    : [{ label: project.projectType === 'mod' ? 'No instance with a mod loader' : 'No instances yet', disabled: true }]
  return (
    <Menu
      align="end"
      trigger={
        <Button size={size} variant="primary" icon={<Download />}>
          Install…
        </Button>
      }
      items={items}
    />
  )
}

export { projectKey }
