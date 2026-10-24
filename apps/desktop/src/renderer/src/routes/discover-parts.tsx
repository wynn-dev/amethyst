import { useState } from 'react'
import { Check, Download, RefreshCw, Star } from 'lucide-react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Badge, Button, Menu, ProgressRing, cn, toast } from '@/ui'
import { useInstances } from '@/data/instances'
import type { InstanceSummary, ProjectHit, ProjectType } from '@/data/types'
import { notYetAvailable } from '@/app/commands'

export const TYPE_LABELS: Record<ProjectType, { one: string; many: string }> = {
  modpack: { one: 'Modpack', many: 'Modpacks' },
  mod: { one: 'Mod', many: 'Mods' },
  resourcepack: { one: 'Resource Pack', many: 'Resource Packs' },
  shader: { one: 'Shader', many: 'Shaders' },
  datapack: { one: 'Data Pack', many: 'Data Packs' },
  world: { one: 'World', many: 'Worlds' },
}

export function SourceBadge({ source }: { source: ProjectHit['source'] }) {
  return source === 'modrinth' ? <Badge tone="success">Modrinth</Badge> : <Badge tone="warning">CurseForge</Badge>
}

/**
 * Local Favourites (B5: Modrinth collections are deferred; v1 keeps local favourites only).
 * TODO(wire): replace with api.favourites.list() → string[] and api.favourites.toggle(projectKey).
 */
export const useFavourites = create<{ ids: string[]; toggle: (id: string) => void }>()(
  persist(
    (set) => ({
      ids: [],
      toggle: (id) => set((s) => ({ ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id] })),
    }),
    { name: 'amethyst:favourites', version: 1 },
  ),
)

export function FavouriteButton({ project, size = 'md' }: { project: Pick<ProjectHit, 'id' | 'title'>; size?: 'sm' | 'md' }) {
  const on = useFavourites((s) => s.ids.includes(project.id))
  const toggle = useFavourites((s) => s.toggle)
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Remove ${project.title} from Favourites` : `Add ${project.title} to Favourites`}
      title={on ? 'Remove from Favourites' : 'Add to Favourites'}
      onClick={() => toggle(project.id)}
      className={cn(
        'flex items-center justify-center rounded-md hover:bg-fill',
        size === 'md' ? 'size-7 [&_svg]:size-4' : 'size-6 [&_svg]:size-3.5',
        on ? 'text-yellow' : 'text-label-3 hover:text-label-2',
      )}
    >
      <Star className={cn(on && 'fill-current')} />
    </button>
  )
}

type InstallState = 'idle' | 'installing' | 'installed'

/**
 * Install button: Install → progress → Installed ✓ / Update (B5).
 * TODO(wire): api.marketplace.install({ source, projectId, versionId?, instanceId }) → taskId; progress via `tasks:update`.
 * For modpacks: api.instances.createFromModpack({ source, projectId, versionId? }).
 */
export function InstallButton({ project, target, size = 'md' }: { project: ProjectHit; target?: InstanceSummary; size?: 'sm' | 'md' | 'lg' }) {
  const [state, setState] = useState<InstallState>(project.installed === 'installed' ? 'installed' : 'idle')
  const { data: instances = [] } = useInstances()

  const install = (inst?: InstanceSummary) => {
    setState('installing')
    setTimeout(() => {
      setState('installed')
      toast({
        kind: 'success',
        title: project.type === 'modpack' ? `Created “${project.title}”` : `Installed ${project.title}`,
        message: inst ? `Added to “${inst.name}”.` : undefined,
      })
    }, 1400)
  }

  if (state === 'installing')
    return (
      <Button size={size} disabled aria-label={`Installing ${project.title}`}>
        <ProgressRing size={13} /> Installing
      </Button>
    )
  if (state === 'installed' && project.installed !== 'update')
    return (
      <Button size={size} variant="borderless" className="text-label-2" onClick={() => notYetAvailable('Managing installed content from Discover')}>
        <Check className="text-green" /> Installed
      </Button>
    )
  if (project.installed === 'update')
    return (
      <Button size={size} icon={<RefreshCw />} onClick={() => install(target)}>
        Update
      </Button>
    )
  if (project.type === 'modpack' || target)
    return (
      <Button size={size} variant="primary" icon={<Download />} disabled={target && project.compatible === false} onClick={() => install(target)}>
        Install
      </Button>
    )
  // No target: ask which instance (labels over icons, a click menu, never hover).
  return (
    <Menu
      align="end"
      trigger={
        <Button size={size} variant="primary" icon={<Download />}>
          Install…
        </Button>
      }
      items={[
        { kind: 'label', label: 'Install to' },
        ...instances
          .filter((i) => project.type !== 'mod' || i.loader.kind !== 'vanilla')
          .map((i) => ({ label: `${i.name} (${i.minecraft})`, onSelect: () => install(i) })),
      ]}
    />
  )
}
