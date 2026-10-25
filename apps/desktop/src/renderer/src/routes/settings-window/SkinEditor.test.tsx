// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { AccountDetail } from '@shared/services'
import type { Bridge } from '@shared/rpc'
import { queryClient } from '@/data/query'
import { SkinEditorView } from './SkinEditor'

const invoke = vi.fn<Bridge['invoke']>()

function account(patch: Partial<AccountDetail> = {}): AccountDetail {
  return {
    id: 'mc-1',
    kind: 'microsoft',
    name: 'Steve',
    uuid: '00000000000000000000000000000001',
    selected: true,
    status: 'ok',
    avatarUrl: null,
    skin: { url: 'https://textures.minecraft.net/texture/abc', model: 'classic' },
    cape: null,
    skins: [],
    capes: [{ id: 'cape-1', url: 'https://textures.minecraft.net/texture/cape', alias: 'Migrator', active: false }],
    loginHint: null,
    ...patch,
  }
}

function png(width: number, height: number, name = 'skin.png'): File {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return new File([bytes], name, { type: 'image/png' })
}

beforeEach(() => {
  invoke.mockImplementation(async (_service, method, args) => ({ ok: true, value: method === 'setCape' ? account({ cape: { id: String(args[1]), url: 'https://x/cape' } }) : account() }))
  window.amethyst = { invoke, on: () => () => {}, platform: 'darwin' }
})

afterEach(() => {
  cleanup()
  queryClient.clear()
})

function renderEditor(detail: AccountDetail) {
  return render(
    <QueryClientProvider client={queryClient}>
      <SkinEditorView account={detail} />
    </QueryClientProvider>,
  )
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement
}

describe('skin editor', () => {
  it('shows an inline error for a PNG of the wrong size and keeps Apply disabled', async () => {
    const { container } = renderEditor(account())
    await act(async () => fireEvent.change(fileInput(container), { target: { files: [png(128, 128)] } }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('128 × 128'))
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true)
  })

  it('previews a valid legacy skin and uploads it only on Apply', async () => {
    const { container } = renderEditor(account())
    await act(async () => fireEvent.change(fileInput(container), { target: { files: [png(64, 32, 'old.png')] } }))
    await waitFor(() => expect(screen.getByText(/Previewing “old.png” \(legacy 64 × 32 skin\)/)).toBeTruthy())
    expect(invoke).not.toHaveBeenCalled()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply' })))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('accounts', 'setSkin', ['mc-1', { dataUrl: expect.stringMatching(/^data:image\/png;base64,/) }, 'classic']))
  })

  it('stages a cape and sends only the cape', async () => {
    renderEditor(account())
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: 'Migrator' })))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply' })))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('accounts', 'setCape', ['mc-1', 'cape-1']))
    expect(invoke.mock.calls.some(([, m]) => m === 'setSkin')).toBe(false)
  })

  it('explains offline accounts and offers no capes', () => {
    renderEditor(account({ kind: 'offline', id: 'offline:1', skin: null, capes: [] }))
    expect(screen.getByText('Only shown in Amethyst; the game uses the default skin for offline accounts.')).toBeTruthy()
    expect(screen.getByText('Capes need a Microsoft account.')).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Cape' })).toBeNull()
  })
})
