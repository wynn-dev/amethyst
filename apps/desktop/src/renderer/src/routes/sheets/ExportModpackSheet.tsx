import { useMemo, useState } from 'react'
import { File, Folder, Plus } from 'lucide-react'
import { Button, Checkbox, DitherBar, IconButton, Segmented, Sheet, TextField, recentTrigger } from '@/ui'
import { QueryError } from '@/app/RouteStates'
import { formatBytes } from '@/app/visuals'
import { loaderLabel, useInstanceInfo } from '@/data/instance-info'
import { exportModpack, useExportFiles, useModpackUi } from '@/data/modpacks'
import { pickSaveFile } from '@/lib/files'
import { Card, CardHeader, Note, Row } from './parts'

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
      origin={recentTrigger}
      footerLeading={chosen.length > 0 ? <span className="text-meta text-label-2 tabular">About {formatBytes(size)} before linking</span> : undefined}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={busy || chosen.length === 0 || !name.trim()} onClick={() => void run()}>
            {busy ? 'Exporting…' : 'Export…'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Card>
          <Row label="Format">
            <Segmented
              aria-label="Format"
              value={format}
              onValueChange={setFormat}
              options={[
                { value: 'mrpack', label: 'Modrinth (.mrpack)' },
                { value: 'curseforge', label: 'CurseForge (.zip)' },
              ]}
            />
          </Row>
          <Row label="Name" htmlFor="export-name">
            <TextField id="export-name" value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
          </Row>
          <Row label="Version" htmlFor="export-version">
            <TextField id="export-version" monospace value={version} onChange={(e) => setVersion(e.target.value)} className="!w-[120px]" />
            <IconButton label="Bump version" variant="push" onClick={() => setVersion(bump(version))}>
              <Plus />
            </IconButton>
          </Row>
        </Card>
        <section aria-label="Files to include" className="overflow-hidden rounded-[10px] border border-separator">
          <CardHeader
            title="Files to include"
            count={files.data ? `${chosen.length}/${files.data.length}` : undefined}
            action={
              files.data && (
                <Checkbox
                  label="All"
                  checked={chosen.length === 0 ? false : chosen.length === files.data.length ? true : 'indeterminate'}
                  onCheckedChange={(on) => setIncluded(new Set(on ? files.data.map((f) => f.path) : []))}
                  className="ml-1.5 [&_label>span:first-child]:text-meta"
                />
              )
            }
          />
          {files.isPending ? (
            <div className="flex h-24 items-center justify-center">
              <DitherBar label="Reading the instance folder" className="w-40" />
            </div>
          ) : files.isError ? (
            <QueryError error={files.error} onRetry={() => files.refetch()} what="the instance folder" />
          ) : (
            <ul className="flex max-h-[248px] flex-col divide-y divide-separator overflow-y-auto">
              {(files.data ?? []).map((f) => (
                <li key={f.path} className="flex h-8 shrink-0 items-center gap-2.5 px-3 hover:bg-hover">
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
                  {f.isDirectory ? <Folder className="size-3.5 shrink-0 text-label-2" strokeWidth={1.5} /> : <File className="size-3.5 shrink-0 text-label-3" strokeWidth={1.5} />}
                  <span className="min-w-0 flex-1 truncate font-mono text-meta">{f.path}</span>
                  <span className="shrink-0 font-mono text-[11px] text-label-2 tabular">
                    {f.isDirectory ? `${f.files} file${f.files === 1 ? '' : 's'} · ` : ''}
                    {formatBytes(f.size)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <Note>Mods and packs from Modrinth{format === 'curseforge' ? ' or CurseForge' : ''} are linked, not bundled. Worlds, logs and screenshots are left out unless you tick them.</Note>
      </div>
    </Sheet>
  )
}
