import { describe, expect, it, vi } from 'vitest'
import { createMediaPicker, type ShowOpenPanel } from './media-picker'

describe('mediaPicker.pickBackground', () => {
  it('returns the chosen path and offers image and video filters', async () => {
    const show = vi.fn<ShowOpenPanel>(async () => ({ canceled: false, filePaths: ['/Users/me/Pictures/bg.jpg'] }))
    await expect(createMediaPicker(show).pickBackground()).resolves.toEqual({ path: '/Users/me/Pictures/bg.jpg' })
    const options = show.mock.calls[0]![0]
    expect(options.properties).toEqual(['openFile'])
    expect(options.filters[0]!.extensions).toEqual(expect.arrayContaining(['png', 'jpg', 'webp', 'mp4', 'mov', 'webm']))
    expect(options.filters[0]!.extensions).not.toContain('svg')
  })

  it('resolves null when cancelled or empty', async () => {
    await expect(createMediaPicker(async () => ({ canceled: true, filePaths: ['/x.png'] })).pickBackground()).resolves.toBeNull()
    await expect(createMediaPicker(async () => ({ canceled: false, filePaths: [] })).pickBackground()).resolves.toBeNull()
  })
})
