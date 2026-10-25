import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import type { AccountRow, MicrosoftLoginMethod } from '@shared/services'
import type { Events } from '@shared/events'
import { api } from '@/lib/rpc'
import { toastError } from '@/lib/error-messages'
import { toast } from '@/ui/toast-store'
import { queryClient } from './query'
import type { Account } from './types'

export const accountKeys = {
  all: ['accounts'] as const,
  list: ['accounts', 'list'] as const,
  status: ['accounts', 'status'] as const,
  detail: (id: string) => ['accounts', 'detail', id] as const,
}

/** Stable hue per account for the generated head (until a skin face is drawn). */
export function hueOf(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

export function toAccount(a: AccountRow): Account {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    uuid: a.uuid,
    status: a.status,
    active: a.selected,
    hue: hueOf(a.uuid || a.id),
    ...(a.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
    ...(a.skin ? { skinUrl: a.skin.url } : {}),
  }
}

export const accountsQuery = { queryKey: accountKeys.list, queryFn: async () => (await api.accounts.list()).map(toAccount) }

/** Accounts, the selected one flagged `active`. Refreshed by `accounts:changed`. */
export function useAccounts() {
  return useQuery(accountsQuery)
}

/** Which kinds of sign-in this build can offer. */
export function useAccountsStatus() {
  return useQuery({ queryKey: accountKeys.status, queryFn: () => api.accounts.getStatus() })
}

function refreshAccounts(list?: Account[]) {
  if (list) queryClient.setQueryData(accountKeys.list, list)
  void queryClient.invalidateQueries({ queryKey: accountKeys.all })
}

export const accountActions = {
  async select(a: Pick<Account, 'id' | 'name'>) {
    queryClient.setQueryData<Account[]>(accountKeys.list, (l) => l?.map((x) => ({ ...x, active: x.id === a.id })))
    try {
      await api.accounts.select(a.id)
    } catch (e) {
      refreshAccounts()
      toastError(e, `Couldn’t switch to ${a.name}`)
    }
  },
  async remove(a: Pick<Account, 'id' | 'name'>, displayName = a.name) {
    try {
      await api.accounts.remove(a.id)
      refreshAccounts(queryClient.getQueryData<Account[]>(accountKeys.list)?.filter((x) => x.id !== a.id))
      toast({ kind: 'success', title: `Removed ${displayName}` })
    } catch (e) {
      toastError(e, `Couldn’t remove ${displayName}`)
    }
  },
  /** Rejects with the service error so the form can show it inline. */
  async addOffline(name: string, uuid?: string): Promise<Account> {
    const row = await api.accounts.addOffline(name, uuid || undefined)
    refreshAccounts()
    return toAccount(row)
  },
}

/* ------------------------------------------------------------------------------------------ */
/* Microsoft sign-in                                                                            */
/* ------------------------------------------------------------------------------------------ */

export type LoginStage = Events['accounts:login'] | { stage: 'idle' } | { stage: 'starting'; method: MicrosoftLoginMethod }

/** Live progress of the interactive sign-in (`accounts:login`). */
export const useLoginStage = create<{ stage: LoginStage }>()(() => ({ stage: { stage: 'idle' } }))

export function applyLoginEvent(e: Events['accounts:login']): void {
  useLoginStage.setState({ stage: e })
}

/** Start a Microsoft sign-in. Resolves with the new account; rejects with the coded error. */
export async function loginMicrosoft(method: MicrosoftLoginMethod, accountId?: string): Promise<Account> {
  useLoginStage.setState({ stage: { stage: 'starting', method } })
  const row = await api.accounts.loginMicrosoft({ method, ...(accountId ? { accountId } : {}) })
  refreshAccounts()
  return toAccount(row)
}

export function cancelLogin(): void {
  useLoginStage.setState({ stage: { stage: 'idle' } })
  void api.accounts.cancelLogin().catch(() => {})
}
