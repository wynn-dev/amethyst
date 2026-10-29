// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { ChipGroup, ToggleChip } from './Chips'

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
    const onChange = vi.fn<(v: Show) => void>()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: /Disabled/ }))
    expect(onChange).toHaveBeenCalledWith('disabled')
    expect(screen.getByRole('radio', { name: /Disabled/ }).getAttribute('aria-checked')).toBe('true')
  })
})

function Filters({ known, onToggle }: { known: boolean; onToggle: (on: boolean) => void }) {
  const [show, setShow] = useState<Show>('all')
  const [updates, setUpdates] = useState(false)
  return (
    <>
      <ChipGroup<Show>
        aria-label="Show"
        value={show}
        onValueChange={setShow}
        options={[
          { value: 'all', label: 'All' },
          { value: 'enabled', label: 'Enabled' },
          { value: 'disabled', label: 'Disabled' },
        ]}
      />
      <ToggleChip
        pressed={updates}
        onPressedChange={(on) => {
          setUpdates(on)
          onToggle(on)
        }}
        count={known ? 3 : undefined}
        disabled={!known}
      >
        Updates
      </ToggleChip>
    </>
  )
}

describe('ToggleChip', () => {
  it('is a toggle button outside the radio group, so it combines with the selection', () => {
    const onToggle = vi.fn<(on: boolean) => void>()
    render(<Filters known onToggle={onToggle} />)
    const chip = screen.getByRole('button', { name: /Updates/ })
    expect(screen.getByRole('radiogroup').contains(chip)).toBe(false)
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(chip.textContent).toBe('Updates3')
    fireEvent.click(screen.getByRole('radio', { name: 'Enabled' }))
    fireEvent.click(chip)
    expect(onToggle).toHaveBeenLastCalledWith(true)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    // Both filters hold at once.
    expect(screen.getByRole('radio', { name: 'Enabled' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(chip)
    expect(onToggle).toHaveBeenLastCalledWith(false)
  })

  it('is disabled, without a count, until results are known', () => {
    const onToggle = vi.fn<(on: boolean) => void>()
    render(<Filters known={false} onToggle={onToggle} />)
    const chip = screen.getByRole('button', { name: 'Updates' })
    expect((chip as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(chip)
    expect(onToggle).not.toHaveBeenCalled()
  })
})
