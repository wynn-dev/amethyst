import { useState } from 'react'
import { AlertTriangle, Package } from 'lucide-react'
import { Banner, Button, EmptyState, Sheet, Spinner, TextField } from '@/ui'
import { openInstance } from '@/app/commands'
import { BlockIcon } from '@/app/visuals'
import { loaderLabel, useInstanceRows } from '@/data/instance-info'
import { importModpack, useModpackPreview, useModpackUi } from '@/data/modpacks'
import { errorMessage } from '@/lib/error-messages'
import { PropertyList } from '@/routes/instance/parts'

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
      description={fileName}
      width={520}
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
        <div className="flex h-40 flex-col items-center justify-center gap-2">
          <Spinner label="Reading the modpack" />
          <p className="text-small text-label-2">{source && 'url' in source ? 'Downloading and reading the modpack…' : 'Reading the modpack…'}</p>
        </div>
      ) : preview.isError ? (
        <EmptyState icon={<AlertTriangle className="text-orange" />} title="This modpack can’t be imported" description={errorMessage(preview.error)} className="py-6" />
      ) : p ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <BlockIcon hue={(p.name.length * 47) % 360} label={p.name} size={48} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-title3 font-semibold">{p.name}</p>
              <p className="text-small text-label-2">
                {p.version && `Version ${p.version}`}
                {p.author && ` · by ${p.author}`}
              </p>
              {p.summary && <p className="mt-1 line-clamp-2 text-callout text-label">{p.summary}</p>}
            </div>
          </div>
          <PropertyList
            rows={[
              { label: 'Format', value: p.format === 'modrinth' ? 'Modrinth (.mrpack)' : 'CurseForge' },
              { label: 'Minecraft', value: p.minecraft },
              { label: 'Loader', value: p.loader ? `${loaderLabel(p.loader.kind)} ${p.loader.version}` : 'Vanilla' },
              { label: 'Files', value: `${p.fileCount} downloaded · ${p.overrideCount} included` },
            ]}
          />
          {existing && (
            <Banner tone="info" icon={<Package />} title={`This modpack is already installed as “${existing.name}”`}>
              Importing creates a separate instance. To move “{existing.name}” to a new version, use Update on its Overview.
              <div className="mt-2">
                <Button
                  size="sm"
                  onClick={() => {
                    close()
                    openInstance(existing.id, 'overview')
                  }}
                >
                  Open “{existing.name}”
                </Button>
              </div>
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
          <TextField label="Instance name" value={name} onChange={(e) => setName(e.target.value)} error={nameError} />
          <p className="text-small text-label-2">The game version and files install in the background; progress is shown in Activity. Files a CurseForge author doesn’t allow launchers to download are listed afterwards.</p>
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
    <Sheet open onOpenChange={(o) => !o && set({ importUrl: false })} title="Import Modpack from URL" width={480}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!value || error) return
          set({ importUrl: false, importing: { url: value } })
        }}
      >
        <TextField label="Link" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://cdn.modrinth.com/…/pack.mrpack" error={error} autoFocus />
        <p className="text-small text-label-2">The file is downloaded and previewed before anything is created. For Modrinth projects you can also install from Discover.</p>
        <div className="-mx-5 -mb-4 mt-2 flex justify-end gap-2 border-t border-separator px-5 py-3">
          <Button onClick={() => set({ importUrl: false })}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!value || !!error}>
            Continue
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
