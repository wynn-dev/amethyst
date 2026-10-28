// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { VirtualList, VirtualTable, nextSelection, type Column } from './VirtualList'

// happy-dom has no layout: give every element a 400×300 viewport so the virtualiser can window.
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
})
afterAll(() => {
  cleanup()
  vi.restoreAllMocks()
})

const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: `r${i}`, name: `Row ${i}` }))

describe('VirtualList', () => {
  it('renders only the rows in view plus overscan', () => {
    render(<VirtualList items={rows} rowHeight={30} getKey={(r) => r.id} renderRow={(r) => <span>{r.name}</span>} aria-label="Rows" overscan={5} />)
    const rendered = screen.getAllByRole('listitem')
    // 300 px / 30 px = 10 visible rows, + 5 overscan below.
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThanOrEqual(16)
    expect(screen.getByText('Row 0')).toBeTruthy()
    expect(screen.queryByText('Row 500')).toBeNull()
    cleanup()
  })

  it('sizes the scroll content for every row without rendering them', () => {
    render(<VirtualList items={rows} rowHeight={30} getKey={(r) => r.id} renderRow={(r) => <span>{r.name}</span>} aria-label="Rows" />)
    const list = screen.getByRole('list', { name: 'Rows' })
    expect(list.style.height).toBe(`${10_000 * 30}px`)
    cleanup()
  })
})

describe('nextSelection', () => {
  const keys = ['a', null, 'b', 'c', 'd']
  it('replaces, toggles and extends like a macOS table', () => {
    expect([...nextSelection(keys, new Set(), 0, 2, 'replace')]).toEqual(['b'])
    expect([...nextSelection(keys, new Set(['b']), 2, 3, 'toggle')]).toEqual(['b', 'c'])
    expect([...nextSelection(keys, new Set(['b', 'c']), 2, 3, 'toggle')]).toEqual(['b'])
    // Ranges skip group headers (null keys).
    expect([...nextSelection(keys, new Set(['a']), 0, 4, 'range')]).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('VirtualTable', () => {
  const columns: Column<{ id: string; name: string }>[] = [{ id: 'name', title: 'Name', header: 'Name', width: '1fr', cell: (r) => r.name }]

  function Harness({ onToggle }: { onToggle: (keys: string[]) => void }) {
    const [selection, setSelection] = useState<Set<string>>(new Set())
    return (
      <VirtualTable
        rows={rows.slice(0, 500)}
        columns={columns}
        getKey={(r) => r.id}
        aria-label="Table"
        selection={selection}
        onSelectionChange={setSelection}
        onToggle={onToggle}
      />
    )
  }

  it('supports arrow, shift-arrow, ⌘A and Space', () => {
    const onToggle = vi.fn<(keys: string[]) => void>()
    render(<Harness onToggle={onToggle} />)
    const grid = screen.getByRole('grid', { name: 'Table' })
    expect(grid.getAttribute('aria-rowcount')).toBe('501')
    act(() => grid.focus())
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    fireEvent.keyDown(grid, { key: 'ArrowDown', shiftKey: true })
    expect(screen.getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true')).toHaveLength(2)
    fireEvent.keyDown(grid, { key: ' ' })
    expect(onToggle).toHaveBeenCalledWith(['r1', 'r2'])
    fireEvent.keyDown(grid, { key: 'a', metaKey: true })
    fireEvent.keyDown(grid, { key: ' ' })
    expect(onToggle.mock.lastCall?.[0]).toHaveLength(500)
    cleanup()
  })

  it('re-renders only the rows that changed, and builds row menus only when one opens', () => {
    const renders = new Map<string, number>()
    const memoColumns: Column<{ id: string; name: string }>[] = [
      {
        id: 'name',
        title: 'Name',
        header: 'Name',
        width: '1fr',
        cell: (r) => {
          renders.set(r.id, (renders.get(r.id) ?? 0) + 1)
          return r.name
        },
      },
    ]
    const rowMenu = vi.fn<(keys: string[]) => { label: string }[]>((keys) => [{ label: `Open ${keys.join(',')}` }])
    function Memo({ tick, selection }: { tick: number; selection: Set<string> }) {
      // Inline callbacks, as real callers pass them: they must not defeat the row memo.
      return (
        <div data-tick={tick}>
          <VirtualTable rows={rows.slice(0, 500)} columns={memoColumns} getKey={(r) => r.id} aria-label="Memo" selection={selection} onSelectionChange={() => {}} onActivate={() => {}} rowMenu={rowMenu} />
        </div>
      )
    }
    const none = new Set<string>()
    const { rerender } = render(<Memo tick={0} selection={none} />)
    expect(renders.size).toBeGreaterThan(0)
    const before = [...renders.values()].reduce((a, b) => a + b, 0)
    rerender(<Memo tick={1} selection={none} />)
    expect([...renders.values()].reduce((a, b) => a + b, 0)).toBe(before)
    rerender(<Memo tick={2} selection={new Set(['r1'])} />)
    expect([...renders.values()].reduce((a, b) => a + b, 0)).toBe(before + 1)
    expect(renders.get('r1')).toBe(2)
    expect(rowMenu).not.toHaveBeenCalled()
    cleanup()
  })
})
