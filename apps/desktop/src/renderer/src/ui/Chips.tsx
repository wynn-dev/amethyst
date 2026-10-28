import { useRef, type ReactNode } from 'react'
import { RadioGroup } from 'radix-ui'
import { cn } from './cn'
import { useSlidingIndicator } from './motion'

export interface ChipOption<V extends string> {
  value: V
  label: ReactNode
  /** A count shown after the label in small monospaced figures. */
  count?: number
  disabled?: boolean
}

export interface ChipGroupProps<V extends string> {
  value: V
  onValueChange: (value: V) => void
  options: ChipOption<V>[]
  'aria-label': string
  className?: string
}

/**
 * A row of quiet filter chips with one selected (the mockup's `.chip`): muted labels, a grey pill
 * that slides to the selection on the UI spring, and optional mono counts. A radio group, so the
 * arrow keys move the selection.
 */
export function ChipGroup<V extends string>({ value, onValueChange, options, className, ...aria }: ChipGroupProps<V>) {
  const box = useRef<HTMLDivElement>(null)
  const indicator = useSlidingIndicator(box, '[data-state="checked"]', `${value}:${options.map((o) => o.count ?? '').join()}`)
  return (
    <RadioGroup.Root
      ref={box}
      value={value}
      onValueChange={(v) => onValueChange(v as V)}
      aria-label={aria['aria-label']}
      orientation="horizontal"
      loop
      className={cn('relative flex shrink-0 items-center gap-0.5', className)}
    >
      <span
        ref={indicator}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 rounded-md bg-selection opacity-0 transition-[transform,width,height,opacity] duration-(--duration-spring) ease-spring"
      />
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className={cn(
            'relative flex h-6 items-center gap-[5px] rounded-md px-[9px] text-callout whitespace-nowrap text-label-2 outline-none transition-colors duration-150',
            'hover:text-label focus-visible:shadow-[inset_0_0_0_1.5px_var(--focus-ring)] data-[state=checked]:text-label disabled:opacity-40',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="font-mono text-[10.5px] text-label-3 tabular">{o.count}</span>}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}

/** An outlined chip button (the mockup's `.chip.ol`): a filter or scope that opens something. */
export const chipButtonClass =
  'inline-flex h-6 shrink-0 items-center gap-[5px] rounded-md px-2 text-callout whitespace-nowrap text-label-2 hairline-strong outline-none transition-colors duration-150 hover:bg-hover hover:text-label data-[state=open]:bg-fill data-[state=open]:text-label [&_svg]:size-[13px] [&_svg]:shrink-0'
