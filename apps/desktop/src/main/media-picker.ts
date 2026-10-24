/**
 * The `mediaPicker` main service: native open panels for theme media. No Electron imports here
 * (the dialog is injected), so the filter and result handling are unit tested.
 */
import type { MediaPickerService } from '@shared/services'

/** Background formats the runtime accepts (it re-checks the content by magic bytes). */
export const BACKGROUND_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const
export const BACKGROUND_VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm'] as const

/** The subset of Electron's `OpenDialogOptions` used here. */
export interface OpenPanelOptions {
  title: string
  buttonLabel: string
  properties: 'openFile'[]
  filters: { name: string; extensions: string[] }[]
}

export type ShowOpenPanel = (options: OpenPanelOptions) => Promise<{ canceled: boolean; filePaths: string[] }>

export function createMediaPicker(showOpenPanel: ShowOpenPanel): MediaPickerService {
  return {
    async pickBackground() {
      const result = await showOpenPanel({
        title: 'Choose a Background',
        buttonLabel: 'Choose',
        properties: ['openFile'],
        filters: [
          { name: 'Images and Videos', extensions: [...BACKGROUND_IMAGE_EXTENSIONS, ...BACKGROUND_VIDEO_EXTENSIONS] },
          { name: 'Images', extensions: [...BACKGROUND_IMAGE_EXTENSIONS] },
          { name: 'Videos', extensions: [...BACKGROUND_VIDEO_EXTENSIONS] },
        ],
      })
      const path = result.filePaths[0]
      return result.canceled || !path ? null : { path }
    },
  }
}
