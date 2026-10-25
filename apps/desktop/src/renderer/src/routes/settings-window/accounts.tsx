import { useState } from 'react'
import { AlertTriangle, Minus, Plus, UserRound } from 'lucide-react'
import { Alert, Button, EmptyState, Form, Skeleton, cn } from '@/ui'
import { accountActions, useAccounts } from '@/data/accounts'
import { useSettings } from '@/data/settings'
import type { Account } from '@/data/types'
import { displayName } from '@/app/AccountChip'
import { useUi } from '@/app/ui-store'
import { SkinHead } from '@/app/skin/SkinHead'
import { QueryError } from '@/app/RouteStates'
import { useRowHighlight } from './context'
import { SkinEditor } from './SkinEditor'

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
                <SkinHead skin={a.skinUrl} hue={a.hue} size={30} />
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

      {selected && <SkinEditor key={selected.id} accountId={selected.id} />}

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
