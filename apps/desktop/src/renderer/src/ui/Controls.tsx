import { useId, useRef, type ReactNode } from 'react'
import { Checkbox as RCheckbox, RadioGroup, Slider as RSlider, Switch as RSwitch } from 'radix-ui'
import { Check, ChevronDown, ChevronUp, Minus } from 'lucide-react'
import { cn } from './cn'

/* ------------------------------------------------------------------------------------------ */
/* Switch                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  size?: 'sm' | 'md'
}

/** macOS toggle switch. */
export function Switch({ checked, onCheckedChange, disabled, size = 'md', ...rest }: SwitchProps) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      {...rest}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full p-px transition-colors duration-200 ease-[var(--ease-mac)]',
        'bg-fill-3 shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.08)] data-[state=checked]:bg-accent disabled:opacity-45',
        size === 'md' ? 'h-[18px] w-[32px]' : 'h-[14px] w-[24px]',
      )}
    >
      <RSwitch.Thumb
        className={cn(
          'block rounded-full bg-white shadow-[0_0.5px_2px_rgb(0_0_0/0.3),0_0_0_0.5px_rgb(0_0_0/0.06)] transition-transform duration-200 ease-[var(--ease-mac)]',
          size === 'md' ? 'size-4 data-[state=checked]:translate-x-[14px]' : 'size-3 data-[state=checked]:translate-x-[10px]',
        )}
      />
    </RSwitch.Root>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Checkbox                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface CheckboxProps {
  checked: boolean | 'indeterminate'
  onCheckedChange: (checked: boolean) => void
  label?: ReactNode
  description?: ReactNode
  disabled?: boolean
  id?: string
  'aria-label'?: string
  className?: string
}

/** macOS checkbox with an optional trailing label. Clicking the label toggles it. */
export function Checkbox({ checked, onCheckedChange, label, description, disabled, id, className, ...aria }: CheckboxProps) {
  const autoId = useId()
  const boxId = id ?? autoId
  const box = (
    <RCheckbox.Root
      id={boxId}
      checked={checked}
      disabled={disabled}
      aria-label={aria['aria-label']}
      onCheckedChange={(c) => onCheckedChange(c === true)}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'flex size-[14px] shrink-0 items-center justify-center rounded-[3.5px] bg-control text-on-accent shadow-control',
        'data-[state=checked]:bg-accent data-[state=indeterminate]:bg-accent data-[state=checked]:shadow-none disabled:opacity-45',
      )}
    >
      <RCheckbox.Indicator>
        {checked === 'indeterminate' ? <Minus className="size-2.5" strokeWidth={3.5} /> : <Check className="size-2.5" strokeWidth={3.5} />}
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  )
  if (!label) return box
  return (
    <div className={cn('flex items-start gap-1.5', className)}>
      <div className="flex h-4 items-center">{box}</div>
      <label htmlFor={boxId} className={cn('flex flex-col', disabled && 'opacity-45')}>
        <span className="text-body text-label">{label}</span>
        {description && <span className="text-small text-label-2">{description}</span>}
      </label>
    </div>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Segmented control                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface SegmentOption<V extends string> {
  value: V
  label: ReactNode
  /** Accessible name when the label is an icon. */
  'aria-label'?: string
  disabled?: boolean
}

export interface SegmentedProps<V extends string> {
  value: V
  onValueChange: (value: V) => void
  options: SegmentOption<V>[]
  'aria-label': string
  size?: 'sm' | 'md'
  className?: string
}

/** macOS segmented control (single selection). Arrow keys move between segments. */
export function Segmented<V extends string>({ value, onValueChange, options, size = 'md', className, ...aria }: SegmentedProps<V>) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(v) => onValueChange(v as V)}
      aria-label={aria['aria-label']}
      orientation="horizontal"
      loop
      className={cn('inline-flex shrink-0 items-center rounded-[7px] bg-fill p-[2px]', className)}
    >
      {options.map((o, i) => {
        const prevSelected = options[i - 1]?.value === value
        const selected = o.value === value
        return (
          <RadioGroup.Item
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            aria-label={o['aria-label']}
            className={cn(
              'relative flex items-center justify-center gap-1.5 rounded-[5px] px-2.5 whitespace-nowrap text-label outline-none [&_svg]:size-3.5',
              'transition-[background-color,box-shadow] duration-150 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,var(--accent)_55%,transparent)]',
              size === 'md' ? 'h-[22px] text-body' : 'h-[18px] text-small',
              'data-[state=checked]:bg-control data-[state=checked]:font-medium data-[state=checked]:shadow-control',
              'disabled:opacity-40',
              // Hairline separators between unselected neighbours, like NSSegmentedControl.
              i > 0 &&
                !selected &&
                !prevSelected &&
                'before:absolute before:top-1 before:bottom-1 before:-left-px before:w-px before:bg-separator',
            )}
          >
            {o.label}
          </RadioGroup.Item>
        )
      })}
    </RadioGroup.Root>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Slider                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface SliderProps {
  value: number
  onValueChange: (value: number) => void
  onValueCommit?: (value: number) => void
  min: number
  max: number
  step?: number
  /** Tick marks, e.g. a recommended value. */
  ticks?: number[]
  disabled?: boolean
  'aria-label'?: string
  'aria-labelledby'?: string
  /** Text for assistive technology, e.g. `4 GB`. */
  valueText?: (value: number) => string
  className?: string
}

export function Slider({ value, onValueChange, onValueCommit, min, max, step = 1, ticks, disabled, valueText, className, ...aria }: SliderProps) {
  return (
    <div className={cn('relative flex flex-col gap-1', className)}>
      <RSlider.Root
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={([v]) => v !== undefined && onValueChange(v)}
        onValueCommit={([v]) => v !== undefined && onValueCommit?.(v)}
        className="relative flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-45"
      >
        <RSlider.Track className="relative h-1 grow overflow-hidden rounded-full bg-fill-2">
          <RSlider.Range className="absolute h-full rounded-full bg-accent" />
        </RSlider.Track>
        <RSlider.Thumb
          aria-label={aria['aria-label']}
          aria-labelledby={aria['aria-labelledby']}
          aria-valuetext={valueText?.(value)}
          className="block size-[18px] rounded-full bg-white shadow-[0_0.5px_2.5px_rgb(0_0_0/0.35),0_0_0_0.5px_rgb(0_0_0/0.12)] outline-none focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,var(--accent)_55%,transparent)]"
        />
      </RSlider.Root>
      {ticks && (
        <div className="relative h-1.5" aria-hidden>
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute top-0 h-1.5 w-px bg-label-3"
              style={{ left: `calc(9px + (100% - 18px) * ${(t - min) / (max - min)})` }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Stepper                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface StepperProps {
  value: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** Unit suffix shown after the number, e.g. `MB`. */
  unit?: string
  'aria-label': string
  disabled?: boolean
  width?: number
}

/** Number field with an NSStepper. ↑/↓ step, ⇧↑/⇧↓ step ×10. */
export function Stepper({ value, onValueChange, min = -Infinity, max = Infinity, step = 1, unit, disabled, width = 72, ...aria }: StepperProps) {
  const ref = useRef<HTMLInputElement>(null)
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  const bump = (d: number) => onValueChange(clamp(Math.round((value + d) / step) * step))
  return (
    <div className="inline-flex items-center gap-1">
      <div className="relative">
        <input
          ref={ref}
          type="text"
          inputMode="numeric"
          role="spinbutton"
          aria-label={aria['aria-label']}
          aria-valuenow={value}
          aria-valuemin={Number.isFinite(min) ? min : undefined}
          aria-valuemax={Number.isFinite(max) ? max : undefined}
          disabled={disabled}
          value={String(value)}
          style={{ width }}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/[^\d.-]/g, ''))
            if (!Number.isNaN(n)) onValueChange(n)
          }}
          onBlur={() => onValueChange(clamp(value))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              bump((e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1))
            }
          }}
          className={cn(
            'h-[22px] rounded-[5px] bg-field pr-1.5 pl-[7px] text-right text-body text-label tabular outline-none',
            'shadow-[0_0_0_0.5px_var(--color-label-4)] focus:shadow-[0_0_0_3.5px_color-mix(in_srgb,var(--accent)_45%,transparent),0_0_0_1px_var(--accent)]',
            'disabled:opacity-45',
          )}
        />
      </div>
      {unit && <span className="text-body text-label-2">{unit}</span>}
      <div className="flex h-[22px] w-[13px] flex-col overflow-hidden rounded-[4px] bg-control shadow-control" aria-hidden>
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled || value >= max}
          onClick={() => bump(step)}
          className="flex flex-1 items-center justify-center text-label-2 active:bg-fill-2 disabled:opacity-40"
        >
          <ChevronUp className="size-2.5" strokeWidth={3} />
        </button>
        <span className="h-px bg-separator" />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled || value <= min}
          onClick={() => bump(-step)}
          className="flex flex-1 items-center justify-center text-label-2 active:bg-fill-2 disabled:opacity-40"
        >
          <ChevronDown className="size-2.5" strokeWidth={3} />
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Radio list                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface RadioListProps<V extends string> {
  value: V
  onValueChange: (value: V) => void
  options: { value: V; label: ReactNode; description?: ReactNode; disabled?: boolean }[]
  'aria-label': string
  className?: string
}

/** A vertical group of macOS radio buttons. */
export function RadioList<V extends string>({ value, onValueChange, options, className, ...aria }: RadioListProps<V>) {
  const base = useId()
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(v) => onValueChange(v as V)}
      aria-label={aria['aria-label']}
      className={cn('flex flex-col gap-1.5', className)}
    >
      {options.map((o) => (
        <div key={o.value} className="flex items-start gap-1.5">
          <RadioGroup.Item
            id={`${base}-${o.value}`}
            value={o.value}
            disabled={o.disabled}
            className="mt-px flex size-[14px] shrink-0 items-center justify-center rounded-full bg-control shadow-control data-[state=checked]:bg-accent data-[state=checked]:shadow-none disabled:opacity-45"
          >
            <RadioGroup.Indicator className="size-[5px] rounded-full bg-white" />
          </RadioGroup.Item>
          <label htmlFor={`${base}-${o.value}`} className={cn('flex flex-col', o.disabled && 'opacity-45')}>
            <span className="text-body">{o.label}</span>
            {o.description && <span className="text-small text-label-2">{o.description}</span>}
          </label>
        </div>
      ))}
    </RadioGroup.Root>
  )
}
