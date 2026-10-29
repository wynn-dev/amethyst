import { useState } from 'react'
import { AlertTriangle, Check, Plus, UserRound } from 'lucide-react'
import { Popover, cn } from '@/ui'
import { accountActions, useAccounts } from '@/data/accounts'
import type { Account } from '@/data/types'
import { useSettings } from '@/data/settings'
import { openSettings } from './commands'
import { useUi } from './ui-store'
import { SkinHead } from './skin/SkinHead'

/** Streamer mode masks usernames everywhere. */
export function displayName(name: string, streamer: boolean) {
  return streamer ? `${name.slice(0, 1)}${'•'.repeat(Math.max(3, name.length - 1))}` : name
}

const kindLabel = (a: Account) => (a.kind === 'microsoft' ? 'Microsoft account' : 'Offline account')

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
          className="flex h-9 min-w-0 flex-1 items-center gap-[9px] rounded-lg px-1.5 text-left transition-colors duration-150 hover:bg-hover data-[state=open]:bg-fill"
        >
          {active ? (
            <span className="relative flex">
              <SkinHead skin={active.skinUrl} hue={active.hue} size={24} className="!rounded-full" />
              {expired && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-yellow ring-2 ring-[var(--color-window-2)]" />}
            </span>
          ) : (
            <span className="flex size-6 items-center justify-center rounded-full bg-fill-2 text-label-2 hairline-strong">
              <UserRound className="size-3.5" />
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-compact font-medium">{active ? displayName(active.name, streamer) : 'Add Account'}</span>
            <span className={cn('truncate text-small', expired ? 'text-orange' : 'text-label-3')}>
              {active ? (expired ? 'Session expired' : kindLabel(active)) : 'Not signed in'}
            </span>
          </span>
        </button>
      }
    >
      <div className="p-1" role="menu" aria-label="Accounts">
        {accounts.map((a) => (
          <button
            key={a.id}
            type="button"
            role="menuitemradio"
            aria-checked={a.active}
            onClick={() => switchTo(a)}
            className="flex h-9 w-full items-center gap-2 rounded-[6px] px-1.5 text-left hover:bg-fill-2 focus-visible:bg-fill-2 focus-visible:outline-none"
          >
            <span className="flex w-3.5 justify-center">{a.active && <Check className="size-3.5" strokeWidth={2} />}</span>
            <SkinHead skin={a.skinUrl} hue={a.hue} size={20} className="!rounded-full" />
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-compact">{displayName(a.name, streamer)}</span>
              <span className={cn('truncate text-small', a.status === 'needs-sign-in' ? 'text-orange' : 'text-label-3')}>
                {a.status === 'needs-sign-in' ? 'Session expired' : kindLabel(a)}
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
            className="mt-1 flex h-[26px] w-full items-center rounded-[6px] px-2 text-compact font-medium text-accent hover:bg-fill-2"
          >
            Sign In Again…
          </button>
        )}
        <div className="mx-1 my-1 h-px bg-separator" />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false)
            setUi({ addAccount: true })
          }}
          className="flex h-[26px] w-full items-center gap-2 rounded-[6px] px-2 text-compact hover:bg-fill-2"
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
          className="flex h-[26px] w-full items-center gap-2 rounded-[6px] px-2 text-compact hover:bg-fill-2"
        >
          <span className="w-3.5" /> Manage Accounts…
        </button>
      </div>
    </Popover>
  )
}
