import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Target = { id: string; name: string }

interface UiState {
  palette: boolean
  shortcuts: boolean
  activity: boolean
  newInstance: boolean
  addAccount: boolean
  /** Instance pending a "Move to Trash" confirmation. */
  trash: Target | null
  /** Instance pending a "Duplicate…" sheet. */
  duplicate: Target | null
  sidebarCollapsed: boolean
  sidebarWidth: number
  inspector: boolean
  sidebarFilter: string
  set: (patch: Partial<Omit<UiState, 'set'>>) => void
}

/** Window-local UI state. Only layout preferences persist. */
export const useUi = create<UiState>()(
  persist(
    (set) => ({
      palette: false,
      shortcuts: false,
      activity: false,
      newInstance: false,
      addAccount: false,
      trash: null,
      duplicate: null,
      sidebarCollapsed: false,
      sidebarWidth: 220,
      inspector: true,
      sidebarFilter: '',
      set: (patch) => set(patch),
    }),
    {
      name: 'amethyst:ui',
      version: 1,
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, sidebarWidth: s.sidebarWidth, inspector: s.inspector }),
    },
  ),
)

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 320

/* Find (⌘F) target: the most recently mounted search field on screen. */
const findTargets: HTMLInputElement[] = []

export function registerFindTarget(el: HTMLInputElement): () => void {
  findTargets.push(el)
  return () => {
    const i = findTargets.lastIndexOf(el)
    if (i >= 0) findTargets.splice(i, 1)
  }
}

/** Ref callback for a search field that ⌘F should focus: `<SearchField ref={findTargetRef} … />`. */
export const findTargetRef = (el: HTMLInputElement | null) => (el ? registerFindTarget(el) : undefined)

export function focusFindTarget(): boolean {
  const el = findTargets.toReversed().find((e) => e.isConnected && e.offsetParent !== null)
  if (!el) return false
  el.focus()
  el.select()
  return true
}
