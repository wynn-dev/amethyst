import { useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { AppearanceSettings, DeepPatch } from '@shared/services'
import { assetUrl } from '@shared/paths'
import { api, subscribe } from '@/lib/rpc'
import { applyTheme, cacheTheme, DEFAULT_ACCENT, readCachedTheme } from '@/lib/theme'
import { toast } from '@/ui'
import { queryClient } from './query'

/**
 * The appearance settings group (B8), read from and written to the runtime's settings service.
 * Kept under its own query key so it never collides with the general settings cache; it follows
 * `settings:changed`, so changes made anywhere (either window, Settings → General) show up live.
 */
const KEY = ['appearance'] as const

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'system',
  accentColor: DEFAULT_ACCENT,
  background: { kind: 'none', file: null, fit: 'cover', blur: 0, overlay: true },
  blur: { card: 20, sidebar: 4 },
  vibrancy: false,
}

function placeholder(): AppearanceSettings {
  const cached = readCachedTheme()
  return cached ? { ...DEFAULT_APPEARANCE, ...cached } : DEFAULT_APPEARANCE
}

/** Deep-merges a settings patch; `null` resets a leaf to its default. */
export function mergeAppearance(base: AppearanceSettings, patch: DeepPatch<AppearanceSettings> | null | undefined): AppearanceSettings {
  if (!patch) return base
  const merge = (target: Record<string, unknown>, p: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...target }
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue
      if (v === null) out[k] = defaults[k]
      else if (typeof v === 'object' && !Array.isArray(v)) out[k] = merge((target[k] ?? {}) as Record<string, unknown>, v as Record<string, unknown>, (defaults[k] ?? {}) as Record<string, unknown>)
      else out[k] = v
    }
    return out
  }
  return merge(base as unknown as Record<string, unknown>, patch as Record<string, unknown>, DEFAULT_APPEARANCE as unknown as Record<string, unknown>) as unknown as AppearanceSettings
}

export function useAppearance(): AppearanceSettings {
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: async () => (await api.settings.get()).appearance,
    placeholderData: placeholder,
  })
  return data ?? DEFAULT_APPEARANCE
}

/** Writes an appearance patch: applied to the cache at once (live preview), then persisted. */
export function usePatchAppearance() {
  return (patch: DeepPatch<AppearanceSettings>) => {
    const previous = queryClient.getQueryData<AppearanceSettings>(KEY) ?? DEFAULT_APPEARANCE
    // An in-flight read must not overwrite the optimistic value with older settings.
    void queryClient.cancelQueries({ queryKey: KEY })
    queryClient.setQueryData<AppearanceSettings>(KEY, mergeAppearance(previous, patch))
    api.settings.patch({ appearance: patch }).then(
      (settings) => queryClient.setQueryData(KEY, settings.appearance),
      (e: Error) => {
        queryClient.setQueryData(KEY, previous)
        toast({ kind: 'error', title: 'Couldn’t save the appearance setting', message: e.message })
      },
    )
  }
}

/** Choose a background in the native open panel and hand it to the runtime, or clear it with `null`. */
export function useSetBackground() {
  return useMutation({
    mutationFn: async (action: 'choose' | 'clear') => {
      if (action === 'clear') return api.settings.setBackground(null)
      const picked = await api.mediaPicker.pickBackground()
      return picked ? api.settings.setBackground(picked) : null
    },
    onSuccess: (settings) => {
      if (settings) queryClient.setQueryData(KEY, settings.appearance)
    },
    onError: (e: Error & { code?: string }) => {
      const description = e.code === 'EUNSUPPORTED_MEDIA' ? 'Choose a PNG, JPEG, GIF or WebP image, or an MP4, MOV or WebM video.' : e.message
      toast({ kind: 'error', title: 'Couldn’t use that file as the background', message: description })
    },
  })
}

/** `amethyst-asset://` URL of the background media, or `null` when there is none. */
export function backgroundUrl(appearance: AppearanceSettings): string | null {
  const { kind, file } = appearance.background
  return kind === 'none' || !file ? null : assetUrl(file)
}

/**
 * Keeps the document's theme in sync with the settings, in every window. Mount once, inside the
 * QueryClientProvider. Also follows `settings:changed` pushed by the runtime.
 */
export function useAppearanceSync(): void {
  const appearance = useAppearance()
  const { theme, accentColor } = appearance

  useEffect(() => {
    applyTheme({ theme, accentColor })
    cacheTheme({ theme, accentColor })
  }, [theme, accentColor])

  useEffect(
    () =>
      subscribe('settings:changed', ({ keys, patch }) => {
        if (!keys.some((k) => k.startsWith('appearance.'))) return
        const current = queryClient.getQueryData<AppearanceSettings>(KEY)
        if (current) queryClient.setQueryData(KEY, mergeAppearance(current, patch.appearance))
        else queryClient.invalidateQueries({ queryKey: KEY })
      }),
    [],
  )
}
