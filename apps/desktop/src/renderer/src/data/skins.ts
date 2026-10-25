import { useMutation, useQuery } from '@tanstack/react-query'
import type { AccountDetail, SkinSource } from '@shared/services'
import { api } from '@/lib/rpc'
import type { SkinModel } from '@/lib/skin'
import { queryClient } from './query'
import { accountKeys } from './accounts'

/**
 * Skins and capes of one account (B9), for the skin editor. The account list itself (`['accounts']`)
 * belongs to the accounts data; mutations here invalidate it so avatars update everywhere.
 */
export const accountDetailKey = accountKeys.detail

/** One account with its skins and capes; refreshed by `accounts:changed` through the event bridge. */
export function useAccountDetail(id: string) {
  return useQuery({ queryKey: accountDetailKey(id), queryFn: () => api.accounts.get(id) })
}

function settle(detail: AccountDetail) {
  queryClient.setQueryData(accountDetailKey(detail.id), detail)
  queryClient.invalidateQueries({ queryKey: accountKeys.list })
}

/**
 * Applies a staged skin and/or cape. Only the parts that changed are sent: the skin first (it can
 * be rejected by Mojang), then the cape. Resolves with the final account detail.
 */
export function useApplySkin(id: string) {
  return useMutation({
    mutationFn: async (change: { skin?: { source: SkinSource; model: SkinModel } | 'reset'; cape?: { id: string | null } }) => {
      let detail: AccountDetail | undefined
      if (change.skin === 'reset') detail = await api.accounts.resetSkin(id)
      else if (change.skin) detail = await api.accounts.setSkin(id, change.skin.source, change.skin.model)
      if (change.cape) detail = await api.accounts.setCape(id, change.cape.id)
      return detail ?? (await api.accounts.get(id))
    },
    onSuccess: settle,
    onError: () => queryClient.invalidateQueries({ queryKey: accountDetailKey(id) }),
  })
}

/** Plain-language text for skin and cape errors (accounts.md §7.2, §7.4). */
export function skinErrorMessage(e: unknown): string {
  const { code, message } = (e ?? {}) as { code?: string; message?: string }
  switch (code) {
    case 'ESKIN_INVALID_PNG':
    case 'ESKIN_BAD_DIMENSIONS':
      return 'This image isn’t a valid skin. Skins are PNG files of 64 × 64 or 64 × 32 pixels.'
    case 'ESKIN_TOO_LARGE':
      return 'This file is too large to be a skin.'
    case 'ESKIN_REJECTED_IMAGE':
      return 'Minecraft rejected this image (invalid or not allowed).'
    case 'ECAPE_INVALID':
      return 'This account doesn’t own that cape.'
    case 'ESIGN_IN_REQUIRED':
    case 'EACCOUNT_MISMATCH':
    case 'EMC_UNAUTHORIZED':
    case 'EMSA_INVALID_GRANT':
    case 'EMSA_INTERACTION_REQUIRED':
      return 'Your session expired. Sign in again, then retry.'
    case 'ENETWORK':
      return 'Couldn’t reach Minecraft services. Check your connection and try again.'
    default:
      return message || 'Something went wrong while changing the skin.'
  }
}
