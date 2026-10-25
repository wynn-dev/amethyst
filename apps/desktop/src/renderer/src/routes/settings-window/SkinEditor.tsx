import { useRef, useState, type DragEvent } from 'react'
import { RadioGroup } from 'radix-ui'
import type { AccountDetail, SkinSource } from '@shared/services'
import { Banner, Button, FormSection, Menu, Segmented, Sheet, Skeleton, TextField, cn, toast } from '@/ui'
import { skinErrorMessage, useAccountDetail, useApplySkin } from '@/data/skins'
import { detectSkinModel, readSkinFile, type SkinFile, type SkinModel } from '@/lib/skin'
import { decodePixels, imageToDataUrl } from '@/lib/skin-image'
import { SkinViewer } from '@/app/skin/SkinViewer'
import { useRowHighlight } from './context'

/**
 * Settings → Accounts: the skin and cape editor (B9, accounts.md §7, §9.5). Every change is a
 * preview on the 3D viewer; nothing is uploaded until Apply, and Revert drops the preview.
 *
 * Follow-up: a local skin library / recent skins (accounts.md §8) needs a contract addition
 * (closet storage in the runtime); it is not part of the accounts service yet.
 */
export function SkinEditor({ accountId }: { accountId: string }) {
  const { data, isPending, isError, error, refetch } = useAccountDetail(accountId)
  if (isPending) {
    return (
      <FormSection title="Skin and Cape">
        <div className="flex gap-5 px-2.5 py-3">
          <Skeleton className="h-[260px] w-[180px] rounded-lg" />
          <div className="flex flex-1 flex-col gap-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-56" />
          </div>
        </div>
      </FormSection>
    )
  }
  if (isError) {
    return (
      <FormSection title="Skin and Cape">
        <div className="p-2.5">
          <Banner tone="warning" title="Couldn’t load this account’s skin" actions={<Button onClick={() => refetch()}>Try Again</Button>}>
            {error.message}
          </Banner>
        </div>
      </FormSection>
    )
  }
  return <SkinEditorView key={data.id} account={data} />
}

type StagedSkin = { kind: 'file'; file: SkinFile } | { kind: 'url'; url: string } | { kind: 'reset' }

export function SkinEditorView({ account }: { account: AccountDetail }) {
  const offline = account.kind === 'offline'
  const baseModel: SkinModel = account.skin?.model ?? 'classic'
  const baseCape = account.cape?.id ?? null
  const [skin, setSkin] = useState<StagedSkin | null>(null)
  const [model, setModel] = useState<SkinModel>(baseModel)
  const [cape, setCape] = useState<string | null>(baseCape)
  const [problem, setProblem] = useState<string | null>(null)
  const [urlOpen, setUrlOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const [dropping, setDropping] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const apply = useApplySkin(account.id)
  const highlighted = useRowHighlight('skin')

  const needsSignIn = account.status === 'needs-sign-in'
  const skinChanged = skin !== null || model !== baseModel
  const capeChanged = cape !== baseCape
  const dirty = skinChanged || capeChanged
  const previewSkin = skin?.kind === 'file' ? skin.file.dataUrl : skin?.kind === 'url' ? skin.url : skin?.kind === 'reset' ? null : (account.skin?.url ?? null)
  const previewCape = cape ? (account.capes.find((c) => c.id === cape)?.url ?? null) : null
  // A model change needs a skin to re-upload; the built-in default can't change arms.
  const canChangeModel = skin?.kind !== 'reset' && (skin !== null || account.skin !== null)

  const revert = () => {
    setSkin(null)
    setModel(baseModel)
    setCape(baseCape)
    setProblem(null)
  }

  const stageFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const read = await readSkinFile(file)
      setProblem(null)
      setSkin({ kind: 'file', file: read })
      // Auto-detect the arms once; the Classic/Slim control can still override it.
      const px = await decodePixels(read.dataUrl).catch(() => null)
      setModel(px ? detectSkinModel(px.data, px.width, px.height) : 'classic')
    } catch (e) {
      setProblem((e as Error).message)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDropping(false)
    void stageFile(e.dataTransfer.files[0])
  }

  const submit = async () => {
    setProblem(null)
    let skinChange: Parameters<typeof apply.mutate>[0]['skin']
    try {
      if (skin?.kind === 'reset') skinChange = 'reset'
      else if (skin?.kind === 'file') skinChange = { source: { dataUrl: skin.file.dataUrl }, model }
      else if (skin?.kind === 'url') skinChange = { source: { url: skin.url }, model }
      else if (model !== baseModel && account.skin) {
        // Arms only: send the current skin again with the new model.
        const url = account.skin.url.replace(/^http:\/\/textures\.minecraft\.net\//i, 'https://textures.minecraft.net/')
        const source: SkinSource = url.startsWith('https://') ? { url } : { dataUrl: await imageToDataUrl(url) }
        skinChange = { source, model }
      }
    } catch (e) {
      setProblem((e as Error).message)
      return
    }
    apply.mutate(
      { skin: skinChange, cape: capeChanged ? { id: cape } : undefined },
      {
        onSuccess: (detail) => {
          setSkin(null)
          setModel(detail.skin?.model ?? 'classic')
          setCape(detail.cape?.id ?? null)
          toast({ kind: 'success', title: skinChange && capeChanged ? 'Skin and cape updated' : skinChange ? (offline ? 'Skin saved' : 'Skin updated') : 'Cape updated' })
        },
        onError: (e) => setProblem(skinErrorMessage(e)),
      },
    )
  }

  return (
    <FormSection title="Skin and Cape">
      <div id="row-skin" className={cn('px-2.5 py-3 transition-colors duration-500', highlighted && 'bg-accent-soft')}>
        <div className="flex w-full gap-5">
          <div
            className={cn('relative h-[260px] w-[180px] shrink-0 rounded-lg transition-shadow', dropping && 'shadow-[0_0_0_2px_var(--accent)]')}
            onPointerEnter={() => setHover(true)}
            onPointerLeave={() => setHover(false)}
            onDragOver={(e) => {
              if (![...e.dataTransfer.types].includes('Files')) return
              e.preventDefault()
              setDropping(true)
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={onDrop}
          >
            <SkinViewer skin={previewSkin} model={model} cape={previewCape} animation={hover ? 'walk' : 'idle'} onError={(m) => setProblem(m)} />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-small font-semibold text-label-2">Skin</span>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented<SkinModel>
                  aria-label="Skin model"
                  value={model}
                  onValueChange={setModel}
                  options={[
                    { value: 'classic', label: 'Classic', disabled: !canChangeModel },
                    { value: 'slim', label: 'Slim', disabled: !canChangeModel },
                  ]}
                />
                <Menu
                  trigger={<Button disabled={needsSignIn}>Change Skin…</Button>}
                  items={[
                    { label: 'Choose File…', onSelect: () => fileInput.current?.click() },
                    { label: 'From URL…', onSelect: () => setUrlOpen(true) },
                    { kind: 'separator' },
                    { label: 'Use Default Skin', disabled: !account.skin && skin === null, onSelect: () => setSkin({ kind: 'reset' }) },
                  ]}
                />
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,.png"
                  hidden
                  aria-hidden
                  tabIndex={-1}
                  onChange={(e) => {
                    void stageFile(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
              </div>
              <p className="text-small text-label-2">
                {skin?.kind === 'file'
                  ? `Previewing “${skin.file.name}”${skin.file.legacy ? ' (legacy 64 × 32 skin)' : ''}. It isn’t ${offline ? 'saved' : 'uploaded'} until you apply it.`
                  : skin?.kind === 'url'
                    ? 'Previewing a skin from the web. It isn’t uploaded until you apply it.'
                    : skin?.kind === 'reset'
                      ? 'Previewing the default skin. Apply to switch back to it.'
                      : 'Drop a PNG on the preview, or choose one. Skins are 64 × 64 or 64 × 32 pixels.'}
              </p>
              {problem && (
                <p role="alert" className="text-small text-red">
                  {problem}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-small font-semibold text-label-2">Cape</span>
              {offline ? (
                <p className="text-small text-label-3">Capes need a Microsoft account.</p>
              ) : (
                <CapePicker capes={account.capes} value={cape} onValueChange={setCape} disabled={needsSignIn} />
              )}
            </div>

            {offline && (
              <Banner tone="info" title="Launcher-only skin">
                Only shown in Amethyst; the game uses the default skin for offline accounts.
              </Banner>
            )}
            {needsSignIn && (
              <Banner tone="warning" title="Sign in again to change this skin">
                The session for this account ended. Sign in again, then change its skin or cape.
              </Banner>
            )}

            <div className="mt-auto flex justify-end gap-2">
              <Button disabled={!dirty || apply.isPending} onClick={revert}>
                Revert
              </Button>
              <Button variant="primary" disabled={!dirty || apply.isPending || needsSignIn} onClick={() => void submit()}>
                {apply.isPending ? 'Applying…' : 'Apply'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <SkinUrlSheet
        open={urlOpen}
        onOpenChange={setUrlOpen}
        onSubmit={(url) => {
          setProblem(null)
          setSkin({ kind: 'url', url })
          setUrlOpen(false)
        }}
      />
    </FormSection>
  )
}

/** Owned capes as front-face thumbnails, plus "None" (a radio group: arrow keys move, Space selects). */
function CapePicker({ capes, value, onValueChange, disabled }: { capes: AccountDetail['capes']; value: string | null; onValueChange: (id: string | null) => void; disabled?: boolean }) {
  return (
    <>
      <RadioGroup.Root
        aria-label="Cape"
        orientation="horizontal"
        loop
        disabled={disabled}
        value={value ?? 'none'}
        onValueChange={(v) => onValueChange(v === 'none' ? null : v)}
        className="flex flex-wrap gap-2"
      >
        {[{ id: 'none', url: null as string | null, alias: 'None' }, ...capes].map((c) => (
          <RadioGroup.Item
            key={c.id}
            value={c.id}
            title={c.alias ?? c.id}
            aria-label={c.alias ?? 'Cape'}
            className={cn(
              'flex h-[60px] w-11 flex-col items-center justify-center gap-1 rounded-md bg-control text-caption text-label-2 shadow-control outline-none',
              'focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--accent)_55%,transparent)] data-[state=checked]:ring-2 data-[state=checked]:ring-accent disabled:opacity-50',
            )}
          >
            {c.url ? <CapeThumb url={c.url} /> : <span className="h-8 w-5 rounded-[2px] border border-dashed border-label-3" />}
            <span className="w-full truncate px-0.5">{c.alias ?? 'Cape'}</span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      {capes.length === 0 && <p className="text-small text-label-3">This account doesn’t own any capes.</p>}
    </>
  )
}

/** The cape's outer face (10×16 at 1,1 of the 64×32 texture), scaled up crisply. */
function CapeThumb({ url }: { url: string }) {
  const src = url.replace(/^http:\/\/textures\.minecraft\.net\//i, 'https://textures.minecraft.net/')
  return (
    <span
      aria-hidden
      className="block h-8 w-5 rounded-[2px] shadow-[0_0_0_0.5px_rgb(0_0_0/0.25)]"
      style={{
        backgroundImage: `url("${src}")`,
        backgroundSize: '640% 200%',
        backgroundPosition: `${(1 / 54) * 100}% ${(1 / 16) * 100}%`,
        imageRendering: 'pixelated',
      }}
    />
  )
}

function SkinUrlSheet({ open, onOpenChange, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; onSubmit: (url: string) => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string>()
  const submit = () => {
    let url: URL
    try {
      url = new URL(value.trim())
    } catch {
      return setError('Enter a full web address, starting with https://')
    }
    if (url.protocol !== 'https:') return setError('Only https:// addresses can be used.')
    setError(undefined)
    onSubmit(url.href)
    setValue('')
  }
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Skin from URL"
      description="Preview a skin PNG from the web. It’s uploaded only when you apply it."
      width={440}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!value.trim()} onClick={submit}>
            Preview
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <TextField
          label="Image address"
          placeholder="https://…/skin.png"
          value={value}
          error={error}
          autoFocus
          onChange={(e) => {
            setValue(e.target.value)
            setError(undefined)
          }}
        />
      </form>
    </Sheet>
  )
}
