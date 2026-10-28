// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { ChipGroup } from './Chips'

afterEach(cleanup)

type Show = 'all' | 'enabled' | 'disabled'

function Harness({ onChange }: { onChange: (v: Show) => void }) {
  const [value, setValue] = useState<Show>('all')
  return (
    <ChipGroup<Show>
      aria-label="Show"
      value={value}
      onValueChange={(v) => {
        setValue(v)
        onChange(v)
      }}
      options={[
        { value: 'all', label: 'All', count: 47 },
        { value: 'enabled', label: 'Enabled', count: 45 },
        { value: 'disabled', label: 'Disabled' },
      ]}
    />
  )
}

describe('ChipGroup', () => {
  it('is a named radio group with one checked chip and counts', () => {
    render(<Harness onChange={() => {}} />)
    expect(screen.getByRole('radiogroup', { name: 'Show' })).toBeTruthy()
    const chips = screen.getAllByRole('radio')
    expect(chips.map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(chips[0]!.textContent).toBe('All47')
    // A chip without a count keeps its exact label.
    expect(chips[2]!.textContent).toBe('Disabled')
  })

  it('selects a chip on click', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: /Disabled/ }))
    expect(onChange).toHaveBeenCalledWith('disabled')
    expect(screen.getByRole('radio', { name: /Disabled/ }).getAttribute('aria-checked')).toBe('true')
  })
})
