import type { ReactNode } from 'react'
import { Select as R } from 'radix-ui'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from './cn'
import { menuItem, menuSurface } from './Menu'

export interface SelectOption<V extends string = string> {
  value: V
  label: ReactNode
  /** Plain-text label for typeahead when `label` is not a string. */
  text?: string
  disabled?: boolean
  /** Render a separator before this option. */
  separatorBefore?: boolean
}

export interface SelectProps<V extends string = string> {
  value: V
  onValueChange: (value: V) => void
  options: SelectOption<V>[]
  /** Accessible name (required when there is no visible <label>). */
  'aria-label'?: string
  id?: string
  disabled?: boolean
  className?: string
  size?: 'sm' | 'md'
  /** `push` is a macOS pop-up button; `borderless` blends into toolbars and table cells. */
  variant?: 'push' | 'borderless'
}

/**
 * macOS pop-up button (Radix Select). The list opens aligned over the trigger, like NSPopUpButton,
 * with a checkmark beside the current item. Type-to-select and arrow keys work.
 */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  id,
  disabled,
  className,
  size = 'md',
  variant = 'push',
  ...aria
}: SelectProps<V>) {
  return (
    <R.Root value={value} onValueChange={(v) => onValueChange(v as V)} disabled={disabled}>
      <R.Trigger
        id={id}
        aria-label={aria['aria-label']}
        className={cn(
          'inline-flex min-w-0 items-center justify-between gap-2 rounded-md pr-1 pl-2.5 text-label outline-none',
          'focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,var(--accent)_55%,transparent)] disabled:opacity-45',
          size === 'md' ? 'h-6 text-body' : 'h-5 text-small',
          variant === 'push' ? 'bg-control shadow-control' : 'hover:bg-fill',
          className,
        )}
      >
        <span className="truncate">
          <R.Value />
        </span>
        <span
          className={cn(
            'flex items-center justify-center rounded-[4px]',
            variant === 'push' ? 'size-4 bg-accent-fill text-on-accent' : 'size-4 text-label-2',
          )}
        >
          <ChevronsUpDown aria-hidden className="size-3" strokeWidth={2.25} />
        </span>
      </R.Trigger>
      <R.Portal>
        <R.Content position="item-aligned" className={cn(menuSurface, 'max-h-[min(400px,var(--radix-select-content-available-height))]')}>
          <R.Viewport>
            {options.map((o) => (
              <div key={o.value}>
                {o.separatorBefore && <R.Separator className="mx-2.5 my-[5px] h-px bg-separator" />}
                <R.Item value={o.value} disabled={o.disabled} textValue={o.text} className={cn(menuItem, 'group')}>
                  <R.ItemIndicator className="absolute left-1.5 flex items-center">
                    <Check strokeWidth={2.5} />
                  </R.ItemIndicator>
                  <R.ItemText>{o.label}</R.ItemText>
                </R.Item>
              </div>
            ))}
          </R.Viewport>
        </R.Content>
      </R.Portal>
    </R.Root>
  )
}
