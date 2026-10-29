// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { TabStrip, tabPanelProps } from './Layout'

afterEach(cleanup)

type Tab = 'overview' | 'mods' | 'logs'

function Harness({ onChange, panelId }: { onChange: (t: Tab) => void; panelId?: string }) {
  const [value, setValue] = useState<Tab>('overview')
  return (
    <>
      <TabStrip
        panelId={panelId}
        aria-label="Instance sections"
        value={value}
        onValueChange={(t) => {
          setValue(t)
          onChange(t)
        }}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'mods', label: 'Mods', count: 47 },
          { value: 'logs', label: 'Logs' },
        ]}
      />
      {panelId && <div {...tabPanelProps(panelId, value)}>{value}</div>}
    </>
  )
}

describe('TabStrip', () => {
  it('is a named tablist with one selected, focusable tab and counts', () => {
    render(<Harness onChange={() => {}} />)
    const list = screen.getByRole('tablist', { name: 'Instance sections' })
    const tabs = screen.getAllByRole('tab')
    expect(list.contains(tabs[0]!)).toBe(true)
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1])
    // Tabs without a count keep their exact label (the e2e driver clicks them by text).
    expect(tabs[2]!.textContent).toBe('Logs')
    expect(tabs[1]!.textContent).toBe('Mods47')
  })

  it('selects with clicks and with ←/→, Home and End (wrapping)', () => {
    const onChange = vi.fn<(t: Tab) => void>()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole('tab', { name: /Mods/ }))
    expect(onChange).toHaveBeenLastCalledWith('mods')
    const list = screen.getByRole('tablist')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('logs')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('overview')
    fireEvent.keyDown(list, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('logs')
    fireEvent.keyDown(list, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('overview')
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
  })

  it('wires the selected tab to the one panel it shows', () => {
    render(<Harness onChange={() => {}} panelId="panel" />)
    const panel = screen.getByRole('tabpanel', { name: 'Overview' })
    expect(panel.id).toBe('panel')
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-controls')).toBe('panel')
    expect(screen.getByRole('tab', { name: /Mods/ }).hasAttribute('aria-controls')).toBe(false)
    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }))
    expect(screen.getByRole('tabpanel', { name: 'Logs' })).toBe(panel)
    expect(screen.getByRole('tab', { name: 'Logs' }).getAttribute('aria-controls')).toBe('panel')
  })
})
