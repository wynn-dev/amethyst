import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, FileDown, FolderSearch } from 'lucide-react'
import { Button, Sheet, Spinner, cn } from '@/ui'
import { formatBytes } from '@/app/visuals'
import { provideManualFiles, stopWatchingManualDownloads, useManualFiles, useModpackUi, watchManualDownloads } from '@/data/modpacks'
import { dragHasFiles, droppedPaths, openExternal } from '@/lib/files'
import { reportError } from '@/lib/error-text'
import { api } from '@/lib/rpc'

/**
 * "Missing files" (DECISIONS.md, CurseForge): files whose authors block launcher downloads. Each
 * links to its download page in the browser; Amethyst watches ~/Downloads for them and accepts
 * drops. Download URLs are never guessed.
 */
export default function MissingFilesDialog() {
  const target = useModpackUi((s) => s.missing)
  const set = useModpackUi((s) => s.set)
  const instanceId = target?.instanceId ?? ''
  const manual = useManualFiles(instanceId)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!instanceId) return
    void watchManualDownloads(instanceId)
    return () => stopWatchingManualDownloads(instanceId)
  }, [instanceId])

  const files = manual.data?.files ?? []
  const done = !manual.isPending && files.length === 0
  const close = () => set({ missing: null })
  const provide = async (paths: string[]) => {
    if (!paths.length) return
    setBusy(true)
    await provideManualFiles(instanceId, paths)
    setBusy(false)
  }

  return (
    <Sheet
      open={!!target}
      onOpenChange={(o) => !o && close()}
      title={done ? 'All files are in place' : `${files.length} file${files.length === 1 ? '' : 's'} must be downloaded by hand`}
      description={done ? `“${target?.name}” is complete.` : `The authors of these files don’t allow launchers to download them. Download each one from CurseForge in your browser; Amethyst picks them up from your Downloads folder.`}
      width={580}
      footerLeading={
        !done && manual.data?.watching ? (
          <span className="flex items-center gap-1.5 text-small text-label-2" role="status">
            <Spinner size={11} /> Watching Downloads…
          </span>
        ) : undefined
      }
      footer={
        <Button variant={done ? 'primary' : 'push'} onClick={close}>
          {done ? 'Done' : 'Finish Later'}
        </Button>
      }
    >
      {done ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <CheckCircle2 className="size-10 text-green" />
          <p className="text-body">Every missing file was found and placed.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex max-h-[300px] flex-col divide-y divide-separator overflow-y-auto rounded-lg bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
            {files.map((f) => (
              <li key={`${f.projectId}:${f.fileId}`} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium">{f.name}</p>
                  <p className="truncate font-mono text-small text-label-2">
                    {f.fileName} · {formatBytes(f.size)}
                  </p>
                </div>
                <Button size="md" icon={<ExternalLink />} onClick={() => openExternal(f.websiteUrl)}>
                  Download Page
                </Button>
              </li>
            ))}
          </ul>
          <div
            role="region"
            aria-label="Drop downloaded files here"
            onDragEnter={(e) => dragHasFiles(e) && setOver(true)}
            onDragLeave={() => setOver(false)}
            onDragOver={(e) => {
              if (!dragHasFiles(e)) return
              e.preventDefault()
              e.stopPropagation()
            }}
            onDrop={(e) => {
              if (!dragHasFiles(e)) return
              e.preventDefault()
              e.stopPropagation()
              setOver(false)
              void provide(droppedPaths(e.dataTransfer))
            }}
            className={cn('flex flex-col items-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors', over ? 'border-accent bg-accent-soft' : 'border-separator')}
          >
            {busy ? <Spinner label="Checking the files" /> : <FileDown className={cn('size-6', over ? 'text-accent' : 'text-label-3')} />}
            <p className="text-body">Downloaded somewhere else? Drop the files here.</p>
            <p className="text-small text-label-2">Each file is checked against the modpack before it’s used.</p>
            <Button
              size="sm"
              className="mt-1"
              icon={<FolderSearch />}
              onClick={async () => {
                const paths = await api.dialog.open({ multiple: true, title: 'Choose the downloaded files' }).catch((e: unknown) => {
                  reportError('Couldn’t open the file picker', e)
                  return [] as string[]
                })
                await provide(paths)
              }}
            >
              Choose Files…
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  )
}
