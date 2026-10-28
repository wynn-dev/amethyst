import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { InstanceRuntime, LoaderKind as RuntimeLoader } from '@shared/services'
import { Button, Checkbox, Combobox, Segmented, Select, Sheet, Spinner, recentTrigger } from '@/ui'
import { api } from '@/lib/rpc'
import { changeVersion, loaderName, useInstance } from '@/data/instances'
import { useAppSettings } from '@/data/settings'
import { useGameVersions, useLoaderVersions } from '@/data/versions'
import type { LoaderKind } from '@/data/types'
import { useUi } from '@/app/ui-store'
import { Card, Row, VersionLabel } from './parts'

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
      origin={recentTrigger}
      bodyClassName="!pb-0"
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
    <div className="flex flex-col gap-3">
      <Card title="Version">
        <Row label="Minecraft">
          <Combobox
            aria-label="Minecraft version"
            value={mc}
            onValueChange={setMc}
            options={options}
            placeholder={versions.isPending ? 'Loading versions…' : 'Choose a version'}
            className="w-[180px]"
            emptyText={versions.isError ? 'Couldn’t load versions' : 'No matching versions'}
          />
          <Checkbox checked={snapshots} onCheckedChange={setSnapshots} label="Show snapshots" className="ml-auto !items-center" />
        </Row>
        <Row label="Mod loader">
          <Segmented
            aria-label="Mod loader"
            value={loader}
            onValueChange={(l) => {
              setLoader(l)
              setLoaderVersion(undefined)
            }}
            options={LOADERS}
          />
        </Row>
        {loader !== 'vanilla' && (
          <Row label={loaderName(loader)}>
            {loaderUnavailable ? (
              <p className="text-meta text-orange">
                {loaderName(loader)} isn’t available for {mc}.
              </p>
            ) : (
              <Select
                aria-label={`${loaderName(loader)} version`}
                value={effectiveLoaderVersion ?? ''}
                onValueChange={setLoaderVersion}
                disabled={lv.isPending}
                className="w-[250px]"
                options={loaderVersions.map((v) => ({
                  value: v.version,
                  text: v.version,
                  label: <VersionLabel version={v.version} recommended={v.recommended} latest={v.latest} />,
                }))}
              />
            )}
          </Row>
        )}
      </Card>

      <section aria-label="What will change" className="overflow-hidden rounded-[10px] border border-separator">
        <h3 className="flex h-8 items-center border-b border-separator px-3 text-meta font-semibold text-label-2">What will change</h3>
        {unchanged ? (
          <p className="flex min-h-[34px] items-center px-3 text-compact text-label-2">Nothing yet. Pick a different version or loader.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-separator text-compact">
            {consequences.map((c) => (
              <li key={c} className="flex min-h-[34px] items-center px-3 py-1.5">
                {c}
              </li>
            ))}
            {changedMc && modCount > 0 && (
              <li className="flex min-h-[34px] items-start gap-2 px-3 py-2 text-orange">
                <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
                {modCount} enabled {modCount === 1 ? 'mod stays' : 'mods stay'} installed. Mods without a version for {mc} may not load; review them in the Mods tab afterwards.
              </li>
            )}
            <li className="flex min-h-[34px] items-center px-3 py-1.5 text-label-2">{backups ? 'Your worlds are backed up first.' : 'Automatic world backups are off in Settings.'}</li>
          </ul>
        )}
        {inst.busy && <p className="border-t border-separator px-3 py-2 text-compact text-orange">Stop the game (or wait for the install) before changing the version.</p>}
      </section>
      <div className="-mx-5 mt-1 flex justify-end gap-2 border-t border-separator px-4 py-2.5">
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={unchanged || loaderUnavailable || !mc || inst.busy || (loader !== 'vanilla' && !effectiveLoaderVersion)} onClick={apply}>
          Change Version
        </Button>
      </div>
    </div>
  )
}
