import { useState } from 'react'
import { AlertTriangle, Minus, Plus, UserRound } from 'lucide-react'
import { Alert, Button, EmptyState, Form, IconButton, Skeleton, cn } from '@/ui'
import { accountActions, useAccounts } from '@/data/accounts'
import { useSettings } from '@/data/settings'
import type { Account } from '@/data/types'
import { displayName } from '@/app/AccountChip'
import { useUi } from '@/app/ui-store'
import { SkinHead } from '@/app/skin/SkinHead'
import { QueryError } from '@/app/RouteStates'
import { useRowHighlight } from './context'
import { SkinEditor } from './SkinEditor'
import { CardHeader } from '@/routes/sheets/parts'

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
      <section
        id="row-accounts"
        aria-label="Accounts"
        className={cn('overflow-hidden rounded-[10px] border border-separator transition-colors duration-500', listHighlighted && 'bg-accent-soft')}
      >
        <CardHeader
          title="Accounts"
          count={isPending ? undefined : list.length}
          action={
            <div className="flex items-center gap-0.5">
              {selected && !selected.active && (
                <Button size="sm" variant="borderless" className="mr-1 text-label-2" onClick={() => void accountActions.select(selected)}>
                  Use This Account
                </Button>
              )}
              <IconButton label="Add Account" size="sm" onClick={() => setUi({ addAccount: true })}>
                <Plus strokeWidth={1.75} />
              </IconButton>
              <IconButton label="Remove Account" size="sm" disabled={!selected} onClick={() => selected && setRemoving(selected)}>
                <Minus strokeWidth={1.75} />
              </IconButton>
            </div>
          }
        />
        <div role="listbox" aria-label="Accounts" className="flex flex-col divide-y divide-separator">
          {isPending &&
            [0, 1].map((i) => (
              <div key={i} className="flex h-[46px] items-center gap-3 px-3">
                <Skeleton className="size-7 rounded-[5px]" />
                <Skeleton className="h-2.5 w-32" />
              </div>
            ))}
          {!isPending && list.length === 0 && (
            <EmptyState
              icon={<UserRound />}
              title="No accounts"
              description="Add a Microsoft account to play online, or an offline account for single-player."
              className="py-7 [&_svg]:!size-5"
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
                className={cn('flex h-[46px] items-center gap-3 px-3 outline-none hover:bg-hover focus-visible:shadow-[inset_0_0_0_1.5px_var(--focus-ring)]', isSel && 'bg-selection hover:bg-selection')}
              >
                <SkinHead skin={a.skinUrl} hue={a.hue} size={26} />
                <div className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-compact font-medium">
                    {displayName(a.name, streamer)}
                    {a.active && <span className="ml-2 text-meta font-normal text-label-2">In use</span>}
                  </span>
                  <span className="text-meta text-label-2">{a.kind === 'microsoft' ? 'Microsoft account' : 'Offline account'}</span>
                </div>
                {a.status === 'needs-sign-in' ? (
                  <span className="flex items-center gap-2">
                    <span className="flex items-center gap-1 text-meta text-orange">
                      <AlertTriangle className="size-3.5" strokeWidth={1.75} /> Session expired
                    </span>
                    <Button size="sm" onClick={() => setUi({ addAccount: true, reauth: a.id })}>
                      Sign In
                    </Button>
                  </span>
                ) : (
                  <span className="text-meta text-label-3">{a.kind === 'offline' ? 'Ready' : 'Signed in'}</span>
                )}
              </div>
            )
          })}
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
