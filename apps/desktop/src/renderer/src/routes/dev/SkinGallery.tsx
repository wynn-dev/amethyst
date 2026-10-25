import { useEffect, useMemo, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import type { AccountDetail } from '@shared/services'
import { Banner, Form, Skeleton } from '@/ui'
import { api } from '@/lib/rpc'
import { makeCape, makeSkin, textureDataUrl, type SkinPalette } from '@/lib/skin-texture'
import { SkinHead } from '@/app/skin/SkinHead'
import { SkinViewer } from '@/app/skin/SkinViewer'
import { SkinEditor, SkinEditorView } from '@/routes/settings-window/SkinEditor'

/**
 * Dev-only test page for the skin viewer (`#/dev/skins`, compiled out of production builds). Used
 * by the screenshot mode: generated 64×64 classic and slim skins, a legacy 64×32 skin, a cape,
 * the default character, the 2D heads, and the skin editor with a fake Microsoft account plus a
 * real offline account created in the running runtime (its skin is served by amethyst-asset://).
 */

const TEAL: SkinPalette = {
  skin: [196, 140, 108, 255],
  hair: [222, 120, 44, 255],
  shirt: [38, 150, 140, 255],
  trim: [240, 230, 200, 255],
  pants: [70, 60, 50, 255],
  shoes: [30, 30, 30, 255],
  eyes: [60, 140, 70, 255],
}
const RED: SkinPalette = {
  skin: [236, 196, 160, 255],
  hair: [40, 32, 30, 255],
  shirt: [196, 52, 52, 255],
  trim: [250, 220, 120, 255],
  pants: [60, 70, 110, 255],
  shoes: [90, 60, 40, 255],
  eyes: [90, 70, 50, 255],
}

function useTextures() {
  return useMemo(
    () => ({
      classic: textureDataUrl(makeSkin({ model: 'classic' })),
      slim: textureDataUrl(makeSkin({ model: 'slim', palette: TEAL })),
      legacy: textureDataUrl(makeSkin({ legacy: true, palette: RED })),
      cape: textureDataUrl(makeCape()),
      cape2: textureDataUrl(makeCape([170, 40, 60, 255], [255, 255, 255, 255])),
    }),
    [],
  )
}

export function SkinGallery() {
  const { view } = useSearch({ strict: false }) as { view?: string }
  return (
    <div className="h-full overflow-y-auto bg-window p-6 text-label">
      <h1 className="text-title2 font-semibold">Skin viewer test page</h1>
      <p className="mb-5 text-small text-label-2">Dev only. Generated textures; drag a model to rotate it.</p>
      {view === 'editors' ? <Editors /> : <Viewers />}
    </div>
  )
}

function Viewers() {
  const t = useTextures()
  const cases: { title: string; skin: string | null; model: 'classic' | 'slim'; cape: string | null }[] = [
    { title: 'Classic 64 × 64', skin: t.classic, model: 'classic', cape: null },
    { title: 'Slim 64 × 64 + cape', skin: t.slim, model: 'slim', cape: t.cape },
    { title: 'Legacy 64 × 32', skin: t.legacy, model: 'classic', cape: t.cape2 },
    { title: 'Default (no skin)', skin: null, model: 'classic', cape: null },
  ]
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-4 gap-5">
        {cases.map((c) => (
          <figure key={c.title} className="flex flex-col gap-2">
            <div className="h-[300px]">
              <SkinViewer skin={c.skin} model={c.model} cape={c.cape} />
            </div>
            <figcaption className="text-small text-label-2">{c.title}</figcaption>
          </figure>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-small font-semibold text-label-2">2D heads (avatar and static fallback)</span>
        <div className="flex items-end gap-6">
          {cases.map((c) => (
            <div key={c.title} className="flex items-end gap-2">
              {[16, 24, 32, 64].map((s) => (
                <SkinHead key={s} skin={c.skin} size={s} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Editors() {
  const t = useTextures()
  const fake: AccountDetail = {
    id: 'dev-microsoft',
    kind: 'microsoft',
    name: 'Tester',
    uuid: '00000000000000000000000000000000',
    selected: true,
    status: 'ok',
    avatarUrl: null,
    skin: { url: t.slim, model: 'slim' },
    cape: { id: 'cape-a', url: t.cape },
    skins: [],
    capes: [
      { id: 'cape-a', url: t.cape, alias: 'Migrator', active: true },
      { id: 'cape-b', url: t.cape2, alias: 'Vanilla', active: false },
    ],
    loginHint: null,
  }
  return (
    <div className="grid grid-cols-2 gap-6">
      <div>
        <p className="mb-2 text-small font-semibold text-label-2">Microsoft account (fake data)</p>
        <Form>
          <SkinEditorView account={fake} />
        </Form>
      </div>
      <div>
        <p className="mb-2 text-small font-semibold text-label-2">Offline account (live runtime)</p>
        <OfflineEditor skin={t.legacy} />
      </div>
    </div>
  )
}

/** Creates (once) an offline account with a launcher-only skin in the real runtime, then edits it. */
function OfflineEditor({ skin }: { skin: string }) {
  const [id, setId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    ;(async () => {
      await api.settings.patch({ general: { developerMode: true } })
      const existing = (await api.accounts.list()).find((a) => a.kind === 'offline' && a.name === 'GalleryTester')
      const row = existing ?? (await api.accounts.addOffline('GalleryTester'))
      if (!row.skin) await api.accounts.setSkin(row.id, { dataUrl: skin }, 'classic')
      if (live) setId(row.id)
    })().catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [skin])
  if (error) return <Banner tone="error" title="Runtime unavailable">{error}</Banner>
  if (!id) return <Skeleton className="h-[300px] w-full rounded-lg" />
  return (
    <Form>
      <SkinEditor accountId={id} />
    </Form>
  )
}
