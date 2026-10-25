import { useMemo, useState } from 'react'
import { File, Folder, Plus } from 'lucide-react'
import { Button, Checkbox, Segmented, Sheet, Spinner, TextField } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { formatBytes } from '@/app/visuals'
import { loaderLabel, useInstanceInfo } from '@/data/instance-info'
import { exportModpack, useExportFiles, useModpackUi } from '@/data/modpacks'
import { pickSaveFile } from '@/lib/files'

type Format = 'mrpack' | 'curseforge'

const bump = (v: string) => {
  const m = /^(.*?)(\d+)(\D*)$/.exec(v)
  return m ? `${m[1]}${Number(m[2]) + 1}${m[3]}` : `${v}.1`
}

/**
 * Export Modpack… (B4.7): format, metadata, the files to include, then a save panel. Mods that
 * are on Modrinth/CurseForge are written as download links; the rest are bundled.
 */
export default function ExportModpackSheet() {
  const target = useModpackUi((s) => s.exporting)
  const set = useModpackUi((s) => s.set)
  const instanceId = target?.instanceId ?? ''
  const info = useInstanceInfo(instanceId)
  const files = useExportFiles(instanceId)
  const [format, setFormat] = useState<Format>('mrpack')
  const [name, setName] = useState(target?.name ?? '')
  const [version, setVersion] = useState('1.0.0')
  const [picked, setIncluded] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState(false)
  const defaults = useMemo(() => new Set((files.data ?? []).filter((f) => f.defaultSelected).map((f) => f.path)), [files.data])
  const included = picked ?? defaults
  const close = () => set({ exporting: null })
  const chosen = useMemo(() => (files.data ?? []).filter((f) => included?.has(f.path)), [files.data, included])
  const size = chosen.reduce((a, f) => a + f.size, 0)

  const run = async () => {
    const ext = format === 'mrpack' ? 'mrpack' : 'zip'
    const output = await pickSaveFile(`${name.trim() || target?.name || 'Modpack'} ${version}.${ext}`, [{ name: format === 'mrpack' ? 'Modrinth modpack' : 'CurseForge modpack', extensions: [ext] }], 'Export Modpack')
    if (!output) return
    setBusy(true)
    const ok = await exportModpack(instanceId, name.trim() || target?.name || '', { format, output, include: chosen.map((f) => f.path), ...(name.trim() ? { name: name.trim() } : {}), ...(version.trim() ? { version: version.trim() } : {}) })
    setBusy(false)
    if (ok) close()
  }

  return (
    <Sheet
      open={!!target}
      onOpenChange={(o) => !o && close()}
      title={`Export “${target?.name}”`}
      description={info.data ? `Minecraft ${info.data.minecraft}${info.data.loader ? ` · ${loaderLabel(info.data.loader.kind)} ${info.data.loader.version}` : ''}` : undefined}
      width={560}
      footerLeading={chosen.length > 0 ? <span className="text-small text-label-2 tabular">About {formatBytes(size)} before linking</span> : undefined}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={busy || chosen.length === 0 || !name.trim()} onClick={() => void run()}>
            {busy ? 'Exporting…' : 'Export…'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-small font-semibold text-label-2">Format</span>
          <Segmented
            aria-label="Format"
            value={format}
            onValueChange={setFormat}
            options={[
              { value: 'mrpack', label: 'Modrinth (.mrpack)' },
              { value: 'curseforge', label: 'CurseForge (.zip)' },
            ]}
          />
        </div>
        <div className="grid grid-cols-[1fr_160px] gap-3">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex items-end gap-1">
            <TextField label="Version" value={version} onChange={(e) => setVersion(e.target.value)} />
            <Button aria-label="Bump version" title="Bump the version" onClick={() => setVersion(bump(version))} className="mb-px">
              <Plus />
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-small font-semibold text-label-2">Files to include</span>
            {files.data && (
              <Checkbox
                label="All"
                checked={chosen.length === 0 ? false : chosen.length === files.data.length ? true : 'indeterminate'}
                onCheckedChange={(on) => setIncluded(new Set(on ? files.data.map((f) => f.path) : []))}
              />
            )}
          </div>
          {files.isPending ? (
            <Spinner label="Reading the instance folder" />
          ) : files.isError ? (
            <QueryError error={files.error} onRetry={() => files.refetch()} what="the instance folder" />
          ) : (
            <ul className="flex max-h-[260px] flex-col divide-y divide-separator overflow-y-auto rounded-lg bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
              {(files.data ?? []).map((f) => (
                <li key={f.path} className="flex h-9 items-center gap-2.5 px-3">
                  <Checkbox
                    checked={included?.has(f.path) ?? false}
                    aria-label={`Include ${f.path}`}
                    onCheckedChange={(on) =>
                      setIncluded((s) => {
                        const next = new Set(s ?? defaults)
                        if (on) next.add(f.path)
                        else next.delete(f.path)
                        return next
                      })
                    }
                  />
                  {f.isDirectory ? <Folder className="size-3.5 text-accent" /> : <File className="size-3.5 text-label-2" />}
                  <span className="min-w-0 flex-1 truncate font-mono text-callout">{f.path}</span>
                  <span className="text-small text-label-2 tabular">
                    {f.isDirectory ? `${f.files} file${f.files === 1 ? '' : 's'} · ` : ''}
                    {formatBytes(f.size)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-small text-label-2">Mods and packs from Modrinth{format === 'curseforge' ? ' or CurseForge' : ''} are linked, not bundled. Worlds, logs and screenshots are left out unless you tick them.</p>
        </div>
      </div>
    </Sheet>
  )
}
