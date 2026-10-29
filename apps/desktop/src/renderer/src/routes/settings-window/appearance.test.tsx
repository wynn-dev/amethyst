// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { AppearanceSettings } from '@shared/services'
import type { Bridge } from '@shared/rpc'
import { DEFAULT_APPEARANCE, useAppearanceSync } from '@/data/appearance'
import { DEFAULT_APP_SETTINGS } from '@/data/settings'
import { queryClient } from '@/data/query'
import { AppearanceQuickRows } from './appearance'

let appearance: AppearanceSettings
const invoke = vi.fn<Bridge['invoke']>()

beforeEach(() => {
  appearance = structuredClone(DEFAULT_APPEARANCE)
  invoke.mockImplementation(async (service, method, args) => {
    if (service === 'settings' && method === 'get') return { ok: true, value: { ...DEFAULT_APP_SETTINGS, appearance } }
    if (service === 'settings' && method === 'patch') {
      appearance = { ...appearance, ...(args[0] as { appearance: Partial<AppearanceSettings> }).appearance }
      return { ok: true, value: { ...DEFAULT_APP_SETTINGS, appearance } }
    }
    return { ok: false, error: { name: 'Error', message: 'unexpected call' } }
  })
  window.amethyst = { invoke, on: () => () => {}, platform: 'darwin' }
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  document.documentElement.removeAttribute('style')
  delete document.documentElement.dataset.appearance
  localStorage.clear()
})

function Sync() {
  useAppearanceSync()
  return null
}

function renderRows() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Sync />
      <AppearanceQuickRows />
    </QueryClientProvider>,
  )
}

const accentVar = () => document.documentElement.style.getPropertyValue('--accent')

describe('accent colour', () => {
  it('applies a swatch live through --accent and saves it to settings', async () => {
    renderRows()
    await waitFor(() => expect(queryClient.getQueryData(['settings'])).toBeDefined())
    await waitFor(() => expect(accentVar()).toBe(''))

    await act(async () => fireEvent.click(screen.getByRole('radio', { name: 'Blue' })))
    await waitFor(() => expect(accentVar()).toContain('#007aff'))
    expect(invoke).toHaveBeenCalledWith('settings', 'patch', [{ appearance: { accentColor: '#007aff' } }])
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Blue' }).getAttribute('aria-checked')).toBe('true'))

    // Back to the default: the stylesheet's neutral light/dark pair takes over again.
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: 'Neutral' })))
    await waitFor(() => expect(accentVar()).toBe(''))
  })

  it('selects Neutral for the old purple default', async () => {
    appearance.accentColor = '#9b5de5'
    renderRows()
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Neutral' }).getAttribute('aria-checked')).toBe('true'))
    expect(accentVar()).toBe('')
  })

  it('applies an accent saved elsewhere when settings load', async () => {
    appearance.accentColor = '#ff9500'
    appearance.theme = 'dark'
    renderRows()
    await waitFor(() => expect(accentVar()).toContain('#ff9500'))
    expect(document.documentElement.dataset.appearance).toBe('dark')
    expect(screen.getByRole('radio', { name: 'Orange' }).getAttribute('aria-checked')).toBe('true')
  })

  it('reverts the preview when saving fails', async () => {
    renderRows()
    await waitFor(() => expect(queryClient.getQueryData(['settings'])).toBeDefined())
    invoke.mockImplementation(async () => ({ ok: false, error: { name: 'Error', message: 'disk full', code: 'EIO' } }))
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: 'Green' })))
    await waitFor(() => expect(accentVar()).toBe(''))
  })
})
