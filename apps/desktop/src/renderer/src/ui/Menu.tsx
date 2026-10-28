import type { ReactElement, ReactNode } from 'react'
import { ContextMenu as CM, DropdownMenu as DM } from 'radix-ui'
import { Check, ChevronRight } from 'lucide-react'
import { cn, shortcutGlyphs } from './cn'

/**
 * Shared look for every menu-like surface (dropdowns, context menus, select lists): frosted glass
 * that grows out of its trigger, with grey highlights (never an accent slab).
 */
export const menuSurface =
  'z-50 min-w-[180px] overflow-hidden rounded-[9px] glass p-1 text-compact text-label shadow-popover ' +
  'data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out origin-(--radix-popper-transform-origin)'

export const menuItem =
  'relative flex h-[26px] cursor-default items-center gap-2 rounded-[5px] pr-2 pl-6 outline-none select-none ' +
  'data-[highlighted]:bg-fill-2 data-[disabled]:text-label-3 ' +
  '[&_svg]:size-3.5 [&_svg]:shrink-0'

const separator = 'mx-2 my-1 h-px bg-separator'
const label = 'px-6 pt-1.5 pb-1 text-small font-semibold text-label-3'

function Shortcut({ keys }: { keys: string }) {
  return <span className="ml-auto pl-6 tracking-[0.08em] text-label-3 group-data-[highlighted]:text-label-2">{shortcutGlyphs(keys)}</span>
}

export interface MenuItemSpec {
  kind?: 'item'
  label: string
  icon?: ReactNode
  shortcut?: string
  disabled?: boolean
  destructive?: boolean
  onSelect?: () => void
}
export interface MenuCheckSpec {
  kind: 'check'
  label: string
  checked: boolean
  shortcut?: string
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}
export interface MenuSubSpec {
  kind: 'sub'
  label: string
  icon?: ReactNode
  disabled?: boolean
  items: MenuEntry[]
}
export type MenuEntry = MenuItemSpec | MenuCheckSpec | MenuSubSpec | { kind: 'separator' } | { kind: 'label'; label: string }

type Parts = typeof DM | typeof CM

function renderEntries(P: Parts, entries: MenuEntry[]): ReactNode {
  return entries.map((e, i) => {
    switch (e.kind) {
      case 'separator':
        return <P.Separator key={i} className={separator} />
      case 'label':
        return (
          <P.Label key={i} className={label}>
            {e.label}
          </P.Label>
        )
      case 'check':
        return (
          <P.CheckboxItem
            key={i}
            checked={e.checked}
            disabled={e.disabled}
            onCheckedChange={(c) => e.onCheckedChange(c === true)}
            className={cn(menuItem, 'group')}
          >
            <P.ItemIndicator className="absolute left-1.5 flex items-center">
              <Check strokeWidth={2.5} />
            </P.ItemIndicator>
            {e.label}
            {e.shortcut && <Shortcut keys={e.shortcut} />}
          </P.CheckboxItem>
        )
      case 'sub':
        return (
          <P.Sub key={i}>
            <P.SubTrigger disabled={e.disabled} className={cn(menuItem, 'group data-[state=open]:bg-fill-2')}>
              {e.icon}
              {e.label}
              <ChevronRight className="ml-auto !size-3 text-label-3 group-data-[highlighted]:text-label-2" />
            </P.SubTrigger>
            <P.Portal>
              <P.SubContent sideOffset={4} alignOffset={-5} className={menuSurface}>
                {renderEntries(P, e.items)}
              </P.SubContent>
            </P.Portal>
          </P.Sub>
        )
      default:
        return (
          <P.Item
            key={i}
            disabled={e.disabled}
            onSelect={e.onSelect}
            className={cn(menuItem, 'group', e.destructive && 'text-red data-[highlighted]:bg-[color-mix(in_srgb,var(--color-red)_14%,transparent)]')}
          >
            {e.icon && <span className="absolute left-1.5 flex text-label-2">{e.icon}</span>}
            {e.label}
            {e.shortcut && <Shortcut keys={e.shortcut} />}
          </P.Item>
        )
    }
  })
}

export interface MenuProps {
  /** The button that opens the menu (rendered `asChild`). */
  trigger: ReactElement
  items: MenuEntry[]
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  modal?: boolean
}

/** Pull-down menu (Radix DropdownMenu). Opens on click, never on hover. */
export function Menu({ trigger, items, align = 'start', side = 'bottom', modal = false }: MenuProps) {
  return (
    <DM.Root modal={modal}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content align={align} side={side} sideOffset={4} collisionPadding={8} className={menuSurface}>
          {renderEntries(DM, items)}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  )
}

export interface ContextMenuProps {
  items: MenuEntry[] | (() => MenuEntry[])
  children: ReactElement
  onOpenChange?: (open: boolean) => void
}

/**
 * The entries of a context menu, built only while it is open: a function `items` is not called
 * when the trigger renders (every row of a list has a context menu).
 */
function ContextEntries({ items }: Pick<ContextMenuProps, 'items'>) {
  return renderEntries(CM, typeof items === 'function' ? items() : items)
}

/** Right-click (and ⌃-click / Shift+F10) menu for any element. */
export function ContextMenu({ items, children, onOpenChange }: ContextMenuProps) {
  return (
    <CM.Root onOpenChange={onOpenChange} modal={false}>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content collisionPadding={8} className={menuSurface}>
          <ContextEntries items={items} />
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  )
}
