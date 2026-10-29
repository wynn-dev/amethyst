import { useState } from 'react'
import { AlertTriangle, Package } from 'lucide-react'
import { Banner, Button, DitherBar, EmptyState, Sheet, TextField, recentTrigger } from '@/ui'
import { openInstance } from '@/app/commands'
import { BlockIcon } from '@/app/visuals'
import { loaderLabel, useInstanceRows } from '@/data/instance-info'
import { importModpack, useModpackPreview, useModpackUi } from '@/data/modpacks'
import { errorMessage } from '@/lib/error-messages'
import { Card, InfoRow, Note, Row } from './parts'

/** Import review (B4.5): preview a pack, confirm the name, then import it as one task. */
export default function ModpackImportSheet() {
  const source = useModpackUi((s) => s.importing)
  const set = useModpackUi((s) => s.set)
  const preview = useModpackPreview(source)
  const { data: instances = [] } = useInstanceRows()
  const p = preview.data
  const [edited, setName] = useState<string | null>(null)
  const name = edited ?? p?.name ?? ''
  const close = () => set({ importing: null })
  const existing = p?.existingInstanceId ? instances.find((i) => i.id === p.existingInstanceId) : undefined
  const trimmed = name.trim()
  const nameError = /[/:]/.test(trimmed) ? 'Names can’t contain “/” or “:”.' : undefined
  const fileName = source && 'path' in source ? source.path.split('/').pop() : source?.url

  const run = () => {
    if (!source || !p) return
    close()
    void importModpack({ source, ...(trimmed && trimmed !== p.name ? { name: trimmed } : {}) }, trimmed || p.name, (id) => openInstance(id, 'overview'))
  }

  return (
    <Sheet
      open={!!source}
      onOpenChange={(o) => !o && close()}
      title="Import Modpack"
      description={fileName && <span className="font-mono text-meta">{fileName}</span>}
      width={540}
      origin={recentTrigger}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!p || !!nameError} onClick={run}>
            {existing ? 'Create Separate Copy' : 'Import'}
          </Button>
        </>
      }
    >
      {preview.isPending ? (
        <div className="flex h-36 flex-col items-center justify-center gap-3">
          <DitherBar label="Reading the modpack" className="w-40" />
          <p className="text-meta text-label-2">{source && 'url' in source ? 'Downloading and reading the modpack…' : 'Reading the modpack…'}</p>
        </div>
      ) : preview.isError ? (
        <EmptyState icon={<AlertTriangle className="text-orange" strokeWidth={1.5} />} title="This modpack can’t be imported" description={errorMessage(preview.error)} className="py-6" />
      ) : p ? (
        <div className="flex animate-enter flex-col gap-3">
          <div className="flex items-start gap-3">
            <BlockIcon hue={(p.name.length * 47) % 360} label={p.name} size={40} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-headline font-semibold">{p.name}</p>
              <p className="text-meta text-label-2 tabular">
                {p.version && `Version ${p.version}`}
                {p.author && ` · by ${p.author}`}
              </p>
              {p.summary && <p className="mt-1 line-clamp-2 text-compact text-label">{p.summary}</p>}
            </div>
          </div>
          <Card title="Contents">
            <InfoRow label="Format" value={p.format === 'modrinth' ? 'Modrinth (.mrpack)' : 'CurseForge'} />
            <InfoRow label="Minecraft" value={<span className="font-mono text-meta">{p.minecraft}</span>} />
            <InfoRow
              label="Loader"
              value={
                p.loader ? (
                  <>
                    {loaderLabel(p.loader.kind)} <span className="font-mono text-meta text-label-2">{p.loader.version}</span>
                  </>
                ) : (
                  'Vanilla'
                )
              }
            />
            <InfoRow label="Files" value={<span className="tabular">{`${p.fileCount} downloaded · ${p.overrideCount} included`}</span>} />
          </Card>
          {existing && (
            <Banner
              tone="info"
              icon={<Package />}
              title={`This modpack is already installed as “${existing.name}”`}
              actions={
                <Button
                  onClick={() => {
                    close()
                    openInstance(existing.id, 'overview')
                  }}
                >
                  Open “{existing.name}”
                </Button>
              }
            >
              Importing creates a separate instance. To move “{existing.name}” to a new version, use Update on its Overview.
            </Banner>
          )}
          {p.warnings.length > 0 && (
            <Banner tone="warning" title={`${p.warnings.length} warning${p.warnings.length === 1 ? '' : 's'}`}>
              <ul className="list-disc pl-4">
                {p.warnings.slice(0, 5).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Banner>
          )}
          <Card>
            <Row label="Instance name" htmlFor="mp-import-name" hintId="mp-import-name-msg" hint={nameError && <span className="text-red">{nameError}</span>}>
              <TextField
                id="mp-import-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? 'mp-import-name-msg' : undefined}
                className="flex-1"
              />
            </Row>
          </Card>
          <Note>The game version and files install in the background; progress is shown in Activity. Files a CurseForge author doesn’t allow launchers to download are listed afterwards.</Note>
        </div>
      ) : null}
    </Sheet>
  )
}

/** "Import from URL…": a Modrinth or direct `https:` link to a .mrpack or CurseForge zip. */
export function ImportUrlSheet() {
  const set = useModpackUi((s) => s.set)
  const [url, setUrl] = useState('')
  const value = url.trim()
  const error = !value ? undefined : /^https:\/\//i.test(value) ? undefined : 'Enter an https:// link to a .mrpack or .zip file.'
  return (
    <Sheet open onOpenChange={(o) => !o && set({ importUrl: false })} title="Import Modpack from URL" width={500} origin={recentTrigger} bodyClassName="!pb-0">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!value || error) return
          set({ importUrl: false, importing: { url: value } })
        }}
      >
        <Card>
          <Row label="Link" htmlFor="mp-url" hintId="mp-url-msg" hint={error && <span className="text-red">{error}</span>}>
            <TextField
              id="mp-url"
              monospace
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://cdn.modrinth.com/…/pack.mrpack"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'mp-url-msg' : undefined}
              className="flex-1"
              autoFocus
            />
          </Row>
        </Card>
        <Note>The file is downloaded and previewed before anything is created. For Modrinth projects you can also install from Discover.</Note>
        <div className="-mx-5 mt-1 flex justify-end gap-2 border-t border-separator px-4 py-2.5">
          <Button onClick={() => set({ importUrl: false })}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!value || !!error}>
            Continue
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
