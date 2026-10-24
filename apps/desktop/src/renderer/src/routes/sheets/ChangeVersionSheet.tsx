import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { InstanceRuntime, LoaderKind as RuntimeLoader } from '@shared/services'
import { Button, Checkbox, Combobox, Segmented, Select, Sheet, Spinner } from '@/ui'
import { api } from '@/lib/rpc'
import { changeVersion, loaderName, useInstance } from '@/data/instances'
import { useAppSettings } from '@/data/settings'
import { useGameVersions, useLoaderVersions } from '@/data/versions'
import type { LoaderKind } from '@/data/types'
import { useUi } from '@/app/ui-store'

const LOADERS: { value: LoaderKind; label: string }[] = [
  { value: 'vanilla', label: 'None' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
]

const close = () => useUi.getState().set({ changeVersion: null })

/** "Change Version…": the same picker as creation, plus what will change (B4.6). */
export default function ChangeVersionSheet({ target }: { target: { id: string; name: string } }) {
  const { data: inst } = useInstance(target.id)
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && close()}
      title="Change Version"
      description={inst ? `Currently Minecraft ${inst.minecraft}${inst.loader.kind === 'vanilla' ? '' : ` with ${loaderName(inst.loader.kind)} ${inst.loader.version}`}.` : undefined}
      width={540}
    >
      {inst ? (
        <VersionForm key={inst.id} inst={{ id: inst.id, name: inst.name, minecraft: inst.minecraft, loader: inst.loader, busy: inst.state.kind !== 'idle' && inst.state.kind !== 'problem' }} />
      ) : (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}
    </Sheet>
  )
}

interface Current {
  id: string
  name: string
  minecraft: string
  loader: { kind: LoaderKind; version?: string }
  busy: boolean
}

function VersionForm({ inst }: { inst: Current }) {
  const backups = useAppSettings().backups.automatic
  const [snapshots, setSnapshots] = useState(false)
  const versions = useGameVersions(snapshots)
  const [mc, setMc] = useState(inst.minecraft)
  const [loader, setLoader] = useState<LoaderKind>(inst.loader.kind)
  const [loaderVersion, setLoaderVersion] = useState<string | undefined>(inst.loader.version)
  const lv = useLoaderVersions(loader, mc)
  const loaderVersions = useMemo(() => lv.data ?? [], [lv.data])
  const mods = useQuery({
    queryKey: ['change-version', 'mods', inst.id],
    enabled: inst.loader.kind !== 'vanilla',
    queryFn: () => api.resources.list(inst.id, 'mods', { limit: 1, enabled: true }).then((p) => p.total),
  })

  // Never silently clear: the chosen version stays listed even when the filter would hide it.
  const options = useMemo(() => {
    const list = (versions.data ?? []).map((v) => ({ value: v.id, label: v.id, detail: v.type === 'release' ? undefined : v.type === 'snapshot' ? 'Snapshot' : 'Old' }))
    return list.some((o) => o.value === mc) || !mc ? list : [{ value: mc, label: mc, detail: undefined }, ...list]
  }, [versions.data, mc])
  const effectiveLoaderVersion =
    loader === 'vanilla' ? undefined : loaderVersions.some((v) => v.version === loaderVersion) ? loaderVersion : (loaderVersions.find((v) => v.recommended) ?? loaderVersions[0])?.version
  const loaderUnavailable = loader !== 'vanilla' && lv.isSuccess && loaderVersions.length === 0
  const changedMc = mc !== inst.minecraft
  const unchanged = !changedMc && loader === inst.loader.kind && (loader === 'vanilla' || effectiveLoaderVersion === inst.loader.version)
  const modCount = mods.data ?? 0

  const consequences: string[] = []
  if (changedMc) consequences.push(`Minecraft ${inst.minecraft} → ${mc}.`)
  if (loader !== inst.loader.kind) {
    if (inst.loader.kind === 'vanilla') consequences.push(`${loaderName(loader)} ${effectiveLoaderVersion ?? ''} will be added.`)
    else if (loader === 'vanilla') consequences.push(`${loaderName(inst.loader.kind)} will be removed. Mods stay in the folder but won’t load.`)
    else consequences.push(`${loaderName(inst.loader.kind)} will be replaced by ${loaderName(loader)}. Mods made for ${loaderName(inst.loader.kind)} may not load.`)
  } else if (loader !== 'vanilla' && effectiveLoaderVersion && effectiveLoaderVersion !== inst.loader.version) consequences.push(`${loaderName(loader)} ${inst.loader.version} → ${effectiveLoaderVersion}.`)
  consequences.push('The right Java for the new version is downloaded automatically if needed.')

  const apply = () => {
    const runtime: Partial<InstanceRuntime> & { minecraft: string } = { minecraft: mc }
    if (loader !== 'vanilla' && effectiveLoaderVersion) runtime[loader as RuntimeLoader] = effectiveLoaderVersion
    void changeVersion(inst, runtime)
    close()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-3">
        <span className="text-right text-body">Minecraft</span>
        <div className="flex items-center gap-3">
          <Combobox
            aria-label="Minecraft version"
            value={mc}
            onValueChange={setMc}
            options={options}
            placeholder={versions.isPending ? 'Loading versions…' : 'Choose a version'}
            className="w-[200px]"
            emptyText={versions.isError ? 'Couldn’t load versions' : 'No matching versions'}
          />
          <Checkbox checked={snapshots} onCheckedChange={setSnapshots} label="Show snapshots" />
        </div>
        <span className="text-right text-body">Mod loader</span>
        <Segmented
          aria-label="Mod loader"
          value={loader}
          onValueChange={(l) => {
            setLoader(l)
            setLoaderVersion(undefined)
          }}
          options={LOADERS}
          className="justify-self-start"
        />
        {loader !== 'vanilla' && (
          <>
            <span className="text-right text-body">{loaderName(loader)}</span>
            {loaderUnavailable ? (
              <p className="text-callout text-orange">
                {loaderName(loader)} isn’t available for {mc}.
              </p>
            ) : (
              <Select
                aria-label={`${loaderName(loader)} version`}
                value={effectiveLoaderVersion ?? ''}
                onValueChange={setLoaderVersion}
                disabled={lv.isPending}
                className="w-[200px]"
                options={loaderVersions.map((v) => ({
                  value: v.version,
                  text: v.version,
                  label: (
                    <span className="flex items-center gap-2">
                      {v.version}
                      {v.recommended && <span className="text-small opacity-70">Recommended</span>}
                      {v.latest && <span className="text-small opacity-70">Latest</span>}
                    </span>
                  ),
                }))}
              />
            )}
          </>
        )}
      </div>

      <section aria-label="What will change" className="rounded-lg bg-surface p-3 shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
        <h3 className="mb-1.5 text-body font-semibold">What will change</h3>
        {unchanged ? (
          <p className="text-callout text-label-2">Nothing yet. Pick a different version or loader.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-callout">
            {consequences.map((c) => (
              <li key={c}>• {c}</li>
            ))}
            {changedMc && modCount > 0 && (
              <li className="flex items-start gap-1.5 text-orange">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                {modCount} enabled {modCount === 1 ? 'mod stays' : 'mods stay'} installed. Mods without a version for {mc} may not load; review them in the Mods tab afterwards.
              </li>
            )}
            <li className="text-label-2">{backups ? 'Your worlds are backed up first.' : 'Automatic world backups are off in Settings.'}</li>
          </ul>
        )}
        {inst.busy && <p className="mt-2 text-callout text-orange">Stop the game (or wait for the install) before changing the version.</p>}
      </section>
      <div className="-mx-5 -mb-4 flex justify-end gap-2 border-t border-separator px-5 py-3">
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={unchanged || loaderUnavailable || !mc || inst.busy || (loader !== 'vanilla' && !effectiveLoaderVersion)} onClick={apply}>
          Change Version
        </Button>
      </div>
    </div>
  )
}
