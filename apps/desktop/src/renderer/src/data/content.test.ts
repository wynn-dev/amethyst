// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ resources: { list: vi.fn<(id: string, kind: string, q: unknown) => Promise<{ total: number }>>() } }))
vi.mock('@/lib/rpc', () => ({ api, subscribe: () => () => {} }))
vi.mock('@/ui/toast-store', () => ({ toast: vi.fn<() => void>() }))

const { useContentCounts } = await import('./content')

afterEach(cleanup)

describe('useContentCounts', () => {
  it('fetches the mod counts again once an instance becomes modded (Change Version)', async () => {
    api.resources.list.mockImplementation(async (_id, kind) => ({ total: kind === 'mods' ? 12 : 3 }))
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result, rerender } = renderHook(({ modded }) => useContentCounts('inst', modded), { wrapper, initialProps: { modded: false } })
    await waitFor(() => expect(result.current.data?.worlds).toBe(3))
    expect(result.current.data?.mods).toBeUndefined()
    expect(api.resources.list).not.toHaveBeenCalledWith('inst', 'mods', expect.anything())

    rerender({ modded: true })
    await waitFor(() => expect(result.current.data?.mods).toBe(12))
    expect(api.resources.list).toHaveBeenCalledWith('inst', 'mods', expect.anything())
  })
})
