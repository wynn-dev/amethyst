import { useState } from 'react'
import { AlertTriangle, Check, ChevronsUpDown, Plus, UserRound } from 'lucide-react'
import { Popover, cn } from '@/ui'
import { accountActions, useAccounts } from '@/data/accounts'
import type { Account } from '@/data/types'
import { useSettings } from '@/data/settings'
import { openSettings } from './commands'
import { useUi } from './ui-store'
import { PlayerHead } from './visuals'

/** Streamer mode masks usernames everywhere. */
export function displayName(name: string, streamer: boolean) {
  return streamer ? `${name.slice(0, 1)}${'•'.repeat(Math.max(3, name.length - 1))}` : name
}

/** Sidebar footer: the active account, with a popover to switch, add or manage accounts (B2.3). */
export function AccountChip() {
  const { data: accounts = [] } = useAccounts()
  const streamer = useSettings().streamerMode
  const setUi = useUi((s) => s.set)
  const [open, setOpen] = useState(false)
  const active = accounts.find((a) => a.active)
  // `expired` is refreshed silently before launch; only `needs-sign-in` needs the user.
  const expired = active?.status === 'needs-sign-in'

  const switchTo = (a: Account) => {
    if (!a.active) void accountActions.select(a)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Accounts"
      side="top"
      align="start"
      width={260}
      trigger={
        <button
          type="button"
          aria-label={active ? `Account: ${active.name}${expired ? ', session expired' : ''}` : 'Add an account'}
          className="flex h-9 w-full items-center gap-2 rounded-lg px-1.5 text-left hover:bg-fill data-[state=open]:bg-fill-2"
        >
          {active ? (
            <span className="relative">
              <PlayerHead hue={active.hue} size={24} />
              {expired && <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-yellow ring-2 ring-[var(--color-window-2)]" />}
            </span>
          ) : (
            <span className="flex size-6 items-center justify-center rounded-[5px] bg-fill-2 text-label-2">
              <UserRound className="size-4" />
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body font-medium">{active ? displayName(active.name, streamer) : 'Add Account'}</span>
            <span className={cn('truncate text-small', expired ? 'text-orange' : 'text-label-2')}>
              {active ? (expired ? 'Session expired' : active.kind === 'microsoft' ? 'Microsoft' : 'Offline') : 'Not signed in'}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-label-3" />
        </button>
      }
    >
      <div className="p-1.5" role="menu" aria-label="Accounts">
        {accounts.map((a) => (
          <button
            key={a.id}
            type="button"
            role="menuitemradio"
            aria-checked={a.active}
            onClick={() => switchTo(a)}
            className="flex h-9 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-accent hover:text-on-accent focus-visible:bg-accent focus-visible:text-on-accent focus-visible:outline-none [&:hover_.sub]:text-on-accent/75"
          >
            <span className="flex w-3.5 justify-center">{a.active && <Check className="size-3.5" strokeWidth={2.5} />}</span>
            <PlayerHead hue={a.hue} size={20} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body">{displayName(a.name, streamer)}</span>
              <span className={cn('sub truncate text-small', a.status === 'needs-sign-in' ? 'text-orange' : 'text-label-2')}>
                {a.status === 'needs-sign-in' ? 'Session expired' : a.kind === 'microsoft' ? 'Microsoft' : 'Offline'}
              </span>
            </span>
            {a.status === 'needs-sign-in' && <AlertTriangle className="size-3.5 text-orange" />}
          </button>
        ))}
        {expired && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              setUi({ addAccount: true, reauth: active?.id ?? null })
            }}
            className="mt-1 flex h-7 w-full items-center rounded-md px-2 text-body font-medium text-accent hover:bg-fill"
          >
            Sign In Again…
          </button>
        )}
        <div className="my-1.5 h-px bg-separator" />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false)
            setUi({ addAccount: true })
          }}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-body hover:bg-accent hover:text-on-accent"
        >
          <Plus className="size-3.5" /> Add Account…
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false)
            openSettings('accounts')
          }}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-body hover:bg-accent hover:text-on-accent"
        >
          <span className="w-3.5" /> Manage Accounts…
        </button>
      </div>
    </Popover>
  )
}
