import { createContext, useContext, type ComponentProps } from 'react'
import { FormRow } from '@/ui'
import { SETTINGS_INDEX } from '@/app/settings-index'

/** The Settings window's search query and deep-linked row, shared with every pane. */
export const SettingsSearchContext = createContext<{ query: string; row?: string }>({ query: '' })

export function matchesQuery(text: string, keywords: string[] | undefined, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  return text.toLowerCase().includes(q) || (keywords ?? []).some((k) => k.toLowerCase().includes(q))
}

/** True when the row is deep-linked (`?row=`) or matches the sidebar search. */
export function useRowHighlight(row: string): boolean {
  const { query, row: linked } = useContext(SettingsSearchContext)
  if (linked === row) return true
  const entry = SETTINGS_INDEX.find((e) => e.row === row)
  return !!entry && matchesQuery(entry.title, entry.keywords, query)
}

/** A FormRow with a stable anchor (`row-<id>`) that lights up for search and deep links. */
export function SettingRow({ row, ...props }: { row: string } & Omit<ComponentProps<typeof FormRow>, 'id' | 'highlighted'>) {
  const highlighted = useRowHighlight(row)
  return <FormRow id={`row-${row}`} highlighted={highlighted} {...props} />
}
