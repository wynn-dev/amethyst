import { lazy, Suspense, useEffect } from 'react'
import { useModpackUi, openModpackImport } from '@/data/modpacks'
import { dragHasFiles, droppedPaths, isModpackPath, isZipPath } from '@/lib/files'
import { toast } from '@/ui/toast-store'

const ModpackImportSheet = lazy(() => import('@/routes/sheets/ModpackImportSheet'))
const ImportUrlSheet = lazy(() => import('@/routes/sheets/ModpackImportSheet').then((m) => ({ default: m.ImportUrlSheet })))
const MissingFilesDialog = lazy(() => import('@/routes/sheets/MissingFilesDialog'))
const ExportModpackSheet = lazy(() => import('@/routes/sheets/ExportModpackSheet'))
const ModpackUpdateSheet = lazy(() => import('@/routes/sheets/ModpackUpdateSheet'))

/**
 * Modpack surfaces mounted once per main window: dropping a `.mrpack` or zip anywhere (the
 * sidebar included) opens the import review; the sheets load on demand.
 */
export function ModpackSurfaces() {
  const ui = useModpackUi()

  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!dragHasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const drop = (e: DragEvent) => {
      if (!dragHasFiles(e)) return
      e.preventDefault()
      const paths = droppedPaths(e.dataTransfer)
      const pack = paths.find((p) => isModpackPath(p) || isZipPath(p))
      if (pack) openModpackImport({ path: pack })
      else if (paths.length) toast({ kind: 'info', title: 'Drop files on an instance’s tab', message: 'Open an instance’s Mods, Resource Packs, Shaders or Worlds tab and drop the files there. Modpacks (.mrpack or .zip) can be dropped anywhere.' })
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  return (
    <Suspense fallback={null}>
      {ui.importing && <ModpackImportSheet />}
      {ui.importUrl && <ImportUrlSheet />}
      {ui.missing && <MissingFilesDialog />}
      {ui.exporting && <ExportModpackSheet />}
      {ui.updating && <ModpackUpdateSheet />}
    </Suspense>
  )
}
