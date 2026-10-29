import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, FileDown, FolderSearch } from 'lucide-react'
import { Button, DitherBar, Sheet, Spinner, cn, recentTrigger } from '@/ui'
import { formatBytes } from '@/app/visuals'
import { provideManualFiles, stopWatchingManualDownloads, useManualFiles, useModpackUi, watchManualDownloads } from '@/data/modpacks'
import { dragHasFiles, droppedPaths, openExternal } from '@/lib/files'
import { toastError } from '@/lib/error-messages'
import { api } from '@/lib/rpc'
import { CardHeader } from './parts'

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
      origin={recentTrigger}
      footerLeading={
        !done && manual.data?.watching ? (
          <span className="flex items-center gap-1.5 text-meta text-label-2" role="status">
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
        <div className="flex animate-enter flex-col items-center gap-2 py-6 text-center">
          <CheckCircle2 className="size-6 text-green" strokeWidth={1.5} />
          <p className="text-compact text-label-2">Every missing file was found and placed.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <section aria-label="Files to download" className="overflow-hidden rounded-[10px] border border-separator">
            <CardHeader title="Files to download" count={files.length} />
            <ul className="flex max-h-[280px] flex-col divide-y divide-separator overflow-y-auto">
              {files.map((f) => (
                <li key={`${f.projectId}:${f.fileId}`} className="flex min-h-[46px] items-center gap-3 px-3 py-1.5">
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="truncate text-compact font-medium">{f.name}</p>
                    <p className="truncate font-mono text-[11px] text-label-2">
                      {f.fileName} · {formatBytes(f.size)}
                    </p>
                  </div>
                  <Button icon={<ExternalLink />} onClick={() => openExternal(f.websiteUrl)}>
                    Download Page
                  </Button>
                </li>
              ))}
            </ul>
          </section>
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
            className={cn(
              'flex flex-col items-center gap-1 rounded-[10px] border border-dashed px-4 py-4 text-center transition-colors duration-150',
              over ? 'border-label-2 bg-hover' : 'border-separator-2',
            )}
          >
            {busy ? <DitherBar label="Checking the files" className="mb-1.5 w-28" /> : <FileDown className={cn('mb-1 size-[18px]', over ? 'text-label' : 'text-label-3')} strokeWidth={1.5} />}
            <p className="text-compact">Downloaded somewhere else? Drop the files here.</p>
            <p className="text-meta text-label-2">Each file is checked against the modpack before it’s used.</p>
            <Button
              className="mt-2"
              icon={<FolderSearch />}
              onClick={async () => {
                const paths = await api.dialog.open({ multiple: true, title: 'Choose the downloaded files' }).catch((e: unknown) => {
                  toastError(e, 'Couldn’t open the file picker')
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
