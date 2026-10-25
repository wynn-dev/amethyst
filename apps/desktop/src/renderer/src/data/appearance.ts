import { useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AppearanceSettings, DeepPatch } from '@shared/services'
import { assetUrl } from '@shared/paths'
import { api } from '@/lib/rpc'
import { applyTheme, cacheTheme } from '@/lib/theme'
import { toast } from '@/ui'
import { queryClient } from './query'
import { DEFAULT_APP_SETTINGS, patchSettings, settingsKey, useAppSettings, type AppSettings } from './settings'

/**
 * The appearance settings group (B8), read from the runtime settings (`useAppSettings`, kept fresh
 * by `settings:changed` through the event bridge) and written with `patchSettings`.
 */

export const DEFAULT_APPEARANCE: AppearanceSettings = DEFAULT_APP_SETTINGS.appearance

/** Background formats the runtime accepts (it re-checks the content by magic bytes). */
export const BACKGROUND_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp']
export const BACKGROUND_VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm']

export function useAppearance(): AppearanceSettings {
  return useAppSettings().appearance
}

/** Writes an appearance patch: optimistic (live preview), persisted by the runtime, rolled back on error. */
export function usePatchAppearance() {
  return (patch: DeepPatch<AppearanceSettings>) => void patchSettings({ appearance: patch })
}

/** Choose a background in the native open panel and hand it to the runtime, or clear it. */
export function useSetBackground() {
  return useMutation({
    mutationFn: async (action: 'choose' | 'clear'): Promise<AppSettings | null> => {
      if (action === 'clear') return api.settings.setBackground(null)
      const [path] = await api.dialog.open({
        title: 'Choose a Background',
        filters: [
          { name: 'Images and Videos', extensions: [...BACKGROUND_IMAGE_EXTENSIONS, ...BACKGROUND_VIDEO_EXTENSIONS] },
          { name: 'Images', extensions: BACKGROUND_IMAGE_EXTENSIONS },
          { name: 'Videos', extensions: BACKGROUND_VIDEO_EXTENSIONS },
        ],
      })
      return path ? api.settings.setBackground({ path }) : null
    },
    onSuccess: (settings) => {
      if (settings) queryClient.setQueryData(settingsKey, settings)
    },
    onError: (e: Error & { code?: string }) => {
      const message = e.code === 'EUNSUPPORTED_MEDIA' ? 'Choose a PNG, JPEG, GIF or WebP image, or an MP4, MOV or WebM video.' : e.message
      toast({ kind: 'error', title: 'Couldn’t use that file as the background', message })
    },
  })
}

/** `amethyst-asset://` URL of the background media, or `null` when there is none. */
export function backgroundUrl(appearance: AppearanceSettings): string | null {
  const { kind, file } = appearance.background
  return kind === 'none' || !file ? null : assetUrl(file)
}

/**
 * Keeps this window's theme (scheme + accent CSS variable) and the native chrome
 * (`nativeTheme.themeSource`, through the main `window` service) in sync with the settings.
 * Mount once per window, inside the QueryClientProvider.
 */
export function useAppearanceSync(): void {
  const { theme, accentColor } = useAppearance()

  useEffect(() => {
    applyTheme({ theme, accentColor })
    cacheTheme({ theme, accentColor })
  }, [theme, accentColor])

  useEffect(() => {
    if (window.amethyst) void api.window.setThemeSource(theme).catch(() => {})
  }, [theme])
}
