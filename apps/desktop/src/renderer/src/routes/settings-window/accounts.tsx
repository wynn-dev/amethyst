import { lazy, Suspense, useState } from 'react'
import { AlertTriangle, Minus, Plus, UserRound } from 'lucide-react'
import { Alert, Banner, Button, EmptyState, Form, FormSection, Menu, Segmented, Skeleton, cn, toast } from '@/ui'
import { accountActions, useAccounts } from '@/data/accounts'
import { useSettings } from '@/data/settings'
import type { Account } from '@/data/types'
import { notYetAvailable } from '@/app/commands'
import { displayName } from '@/app/AccountChip'
import { useUi } from '@/app/ui-store'
import { PlayerHead } from '@/app/visuals'
import { QueryError } from '@/app/RouteStates'
import { useRowHighlight } from './context'

// The 3D viewer is heavy (WebGL); it is a lazy boundary so it never lands in the entry chunk.
const SkinViewer = lazy(() => import('./SkinViewerPlaceholder'))

/** Capes owned by a Microsoft account. TODO(wire): api.skins.listCapes(accountId) → { id, name, hue }[]. */
const OWNED_CAPES = [
  { id: 'migrator', name: 'Migrator', hue: 200 },
  { id: 'vanilla', name: 'Vanilla', hue: 30 },
  { id: 'cherry', name: 'Cherry Blossom', hue: 330 },
]

export function AccountsPane() {
  const { data: accounts, isPending, isError, error, refetch } = useAccounts()
  const streamer = useSettings().streamerMode
  const setUi = useUi((s) => s.set)
  const [selectedId, setSelectedId] = useState<string>()
  const [removing, setRemoving] = useState<Account | null>(null)
  const listHighlighted = useRowHighlight('accounts')

  if (isError) return <QueryError error={error} onRetry={() => refetch()} what="accounts" />
  const list = accounts ?? []
  const selected = list.find((a) => a.id === selectedId) ?? list.find((a) => a.active) ?? list[0]

  return (
    <Form>
      <section id="row-accounts" aria-label="Accounts" className="flex flex-col gap-1.5">
        <div
          role="listbox"
          aria-label="Accounts"
          className={cn(
            'divide-y divide-separator overflow-hidden rounded-lg bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)] transition-colors duration-500',
            listHighlighted && 'bg-accent-soft',
          )}
        >
          {isPending &&
            [0, 1].map((i) => (
              <div key={i} className="flex h-12 items-center gap-3 px-3">
                <Skeleton className="size-8 rounded-[5px]" />
                <Skeleton className="h-2.5 w-32" />
              </div>
            ))}
          {!isPending && list.length === 0 && (
            <EmptyState
              icon={<UserRound />}
              title="No accounts"
              description="Add a Microsoft account to play online, or an offline account for single-player."
              className="py-8"
            />
          )}
          {list.map((a) => {
            const isSel = a.id === selected?.id
            return (
              <div
                key={a.id}
                role="option"
                aria-selected={isSel}
                tabIndex={0}
                onClick={() => setSelectedId(a.id)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    const i = list.indexOf(a) + (e.key === 'ArrowDown' ? 1 : -1)
                    const next = list[i]
                    if (next) {
                      setSelectedId(next.id)
                      ;(e.currentTarget.parentElement?.children[i] as HTMLElement | undefined)?.focus()
                    }
                  }
                }}
                className={cn('flex h-12 items-center gap-3 px-3 outline-none focus-visible:bg-fill', isSel && 'bg-selection')}
              >
                <PlayerHead hue={a.hue} size={30} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body font-medium">
                    {displayName(a.name, streamer)}
                    {a.active && <span className="ml-2 text-small font-normal text-label-2">In use</span>}
                  </span>
                  <span className="text-small text-label-2">{a.kind === 'microsoft' ? 'Microsoft' : 'Offline'}</span>
                </div>
                {a.status === 'needs-sign-in' ? (
                  <span className="flex items-center gap-2">
                    <span className="flex items-center gap-1 text-small text-orange">
                      <AlertTriangle className="size-3.5" /> Session expired
                    </span>
                    <Button size="sm" onClick={() => setUi({ addAccount: true, reauth: a.id })}>
                      Sign In
                    </Button>
                  </span>
                ) : (
                  <span className="text-small text-label-2">{a.kind === 'offline' ? 'Ready' : 'Signed in'}</span>
                )}
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-2 px-0.5">
          <div className="flex overflow-hidden rounded-[5px] bg-control shadow-control">
            <button
              type="button"
              aria-label="Add Account"
              title="Add Account"
              onClick={() => setUi({ addAccount: true })}
              className="flex h-5 w-6 items-center justify-center text-label-2 hover:text-label active:bg-control-pressed"
            >
              <Plus className="size-3" strokeWidth={2.5} />
            </button>
            <span className="w-px bg-separator" />
            <button
              type="button"
              aria-label="Remove Account"
              title="Remove Account"
              disabled={!selected}
              onClick={() => selected && setRemoving(selected)}
              className="flex h-5 w-6 items-center justify-center text-label-2 hover:text-label active:bg-control-pressed disabled:opacity-40"
            >
              <Minus className="size-3" strokeWidth={2.5} />
            </button>
          </div>
          {selected && !selected.active && (
            <Button
              size="sm"
              variant="borderless"
              onClick={() => void accountActions.select(selected)}
            >
              Use This Account
            </Button>
          )}
        </div>
      </section>

      {selected && <SkinEditor key={selected.id} account={selected} />}

      <Alert
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove “${removing ? displayName(removing.name, streamer) : ''}”?`}
        message={removing?.kind === 'microsoft' ? 'Its sign-in is deleted from this Mac. You can add the account again later.' : 'You can add it again later.'}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (!removing) return
          void accountActions.remove(removing, displayName(removing.name, streamer))
          setSelectedId(undefined)
        }}
      />
    </Form>
  )
}

interface SkinState {
  model: 'classic' | 'slim'
  cape: string | null
  /** Source of a previewed skin that is not uploaded yet. */
  skin?: string
}

/** Skin and cape editor. Every change is a preview until Apply (B9). */
function SkinEditor({ account }: { account: Account }) {
  const offline = account.kind === 'offline'
  // TODO(wire): api.skins.get(accountId) → { model, capeId, skinUrl }.
  const [baseline, setBaseline] = useState<SkinState>({ model: 'classic', cape: offline ? null : 'migrator' })
  const [preview, setPreview] = useState<SkinState>(baseline)
  const highlighted = useRowHighlight('skin')
  const dirty = preview.model !== baseline.model || preview.cape !== baseline.cape || !!preview.skin

  const pickSkin = (source: string) => {
    // TODO(wire): native open panel → api.skins.preview(file | url | username); validate 64×64 / 64×32 PNG inline.
    setPreview((p) => ({ ...p, skin: source }))
  }

  return (
    <FormSection title="Skin and Cape" footer={offline ? 'Offline skins are stored on this Mac and used by Amethyst only. Capes need a Microsoft account.' : undefined}>
      <div id="row-skin" className={cn('px-2.5 py-3 transition-colors duration-500', highlighted && 'bg-accent-soft')}>
        <div className="flex w-full gap-5">
          <div className="h-[248px] w-[180px] shrink-0">
            <Suspense fallback={<Skeleton className="size-full rounded-lg" />}>
              <SkinViewer hue={account.hue} model={preview.model} cape={preview.cape} />
            </Suspense>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-small font-semibold text-label-2">Skin</span>
              <div className="flex items-center gap-2">
                <Segmented<SkinState['model']>
                  aria-label="Skin model"
                  value={preview.model}
                  onValueChange={(model) => setPreview((p) => ({ ...p, model }))}
                  options={[
                    { value: 'classic', label: 'Classic' },
                    { value: 'slim', label: 'Slim' },
                  ]}
                />
                <Menu
                  trigger={<Button>Change Skin…</Button>}
                  items={[
                    { label: 'Choose File…', onSelect: () => pickSkin('file') },
                    { label: 'From URL or Username…', onSelect: () => pickSkin('url') },
                    {
                      kind: 'sub',
                      label: 'From Library',
                      items: [
                        { label: 'Knight', onSelect: () => pickSkin('library:knight') },
                        { label: 'Astronaut', onSelect: () => pickSkin('library:astronaut') },
                        { kind: 'separator' },
                        { label: 'Save Current Skin to Library', onSelect: () => notYetAvailable('The skin library') },
                      ],
                    },
                  ]}
                />
              </div>
              {preview.skin && <p className="text-small text-label-2">Previewing a new skin. It isn’t uploaded until you apply it.</p>}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-small font-semibold text-label-2">Cape</span>
              {offline ? (
                <p className="text-small text-label-3">Not available for offline accounts.</p>
              ) : (
                <div role="radiogroup" aria-label="Cape" className="flex flex-wrap gap-2">
                  {[{ id: null, name: 'None', hue: 0 }, ...OWNED_CAPES].map((c) => {
                    const on = preview.cape === c.id
                    return (
                      <button
                        key={c.id ?? 'none'}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        title={c.name}
                        onClick={() => setPreview((p) => ({ ...p, cape: c.id }))}
                        className={cn(
                          'flex h-[54px] w-10 flex-col items-center justify-center gap-1 rounded-md text-caption text-label-2 shadow-control',
                          on ? 'ring-2 ring-accent' : 'bg-control',
                        )}
                      >
                        {c.id ? (
                          <span className="h-7 w-5 rounded-[2px]" style={{ background: `linear-gradient(180deg, hsl(${c.hue} 60% 55%), hsl(${c.hue} 55% 35%))` }} />
                        ) : (
                          <span className="flex h-7 w-5 items-center justify-center rounded-[2px] border border-dashed border-label-3" />
                        )}
                        <span className="w-full truncate px-0.5">{c.name}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {account.status === 'expired' && (
              <Banner tone="warning" title="Session expired">
                Sign in again to change this account’s skin or cape.
              </Banner>
            )}

            <div className="mt-auto flex justify-end gap-2">
              <Button disabled={!dirty} onClick={() => setPreview(baseline)}>
                Revert
              </Button>
              <Button
                variant="primary"
                disabled={!dirty || account.status === 'expired'}
                onClick={() => {
                  // TODO(wire): api.skins.apply(accountId, { model, skin?, capeId }) — uploads only now.
                  toast({ kind: 'success', title: offline ? 'Skin saved' : 'Skin and cape updated' })
                  const applied = { model: preview.model, cape: preview.cape }
                  setBaseline(applied)
                  setPreview(applied)
                }}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
      </div>
    </FormSection>
  )
}
