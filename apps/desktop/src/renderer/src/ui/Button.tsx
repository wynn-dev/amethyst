import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn, shortcutGlyphs } from './cn'
import { Tooltip } from './Tooltip'

export type ButtonVariant = 'push' | 'primary' | 'borderless' | 'destructive' | 'link'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl'

const base =
  'relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-[450] select-none ' +
  'transition-[background-color,box-shadow,opacity,color] duration-150 ease-[var(--ease-mac)] ' +
  'disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0'

const variants: Record<ButtonVariant, string> = {
  push: 'bg-control text-label shadow-control active:bg-control-pressed',
  primary:
    'bg-accent text-on-accent shadow-[0_0_0_0.5px_rgb(0_0_0/0.12),0_0.5px_1.5px_rgb(0_0_0/0.18),inset_0_0.5px_0_rgb(255_255_255/0.22)] ' +
    'hover:bg-accent-hover active:brightness-95',
  borderless: 'text-label hover:bg-fill active:bg-fill-2 data-[state=open]:bg-fill-2',
  destructive:
    'bg-red text-white shadow-[0_0_0_0.5px_rgb(0_0_0/0.12),0_0.5px_1.5px_rgb(0_0_0/0.18)] hover:brightness-105 active:brightness-95',
  link: 'text-accent hover:underline underline-offset-2 !px-0 !h-auto',
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-5 rounded-[5px] px-2 text-small [&_svg]:size-3',
  md: 'h-6 rounded-md px-2.5 text-body [&_svg]:size-3.5',
  lg: 'h-7 rounded-[7px] px-3.5 text-body [&_svg]:size-4',
  xl: 'h-9 rounded-lg px-5 text-title3 font-medium [&_svg]:size-4.5',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Leading icon (lucide component instance). */
  icon?: ReactNode
}

/** macOS push button. `primary` is the default button (accent), `borderless` is a toolbar-style button. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'push', size = 'md', icon, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cn(base, variants[variant], sizes[size], className)} {...rest}>
      {icon}
      {children}
    </button>
  )
})

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Accessible name, also used as the tooltip. Required: icon-only controls must be named. */
  label: string
  /** Shortcut shown in the tooltip, e.g. `mod+k`. */
  shortcut?: string
  variant?: Exclude<ButtonVariant, 'link'>
  size?: 'sm' | 'md' | 'lg'
  tooltip?: boolean
  children: ReactNode
}

const iconSizes = {
  sm: 'size-5 rounded-[5px] [&_svg]:size-3.5',
  md: 'size-7 rounded-md [&_svg]:size-4',
  lg: 'size-8 rounded-[7px] [&_svg]:size-[18px]',
}

/** Icon-only button. Always has an accessible name and a tooltip that includes its shortcut. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, variant = 'borderless', size = 'md', tooltip = true, className, children, type = 'button', ...rest },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      className={cn(base, variants[variant], iconSizes[size], variant === 'borderless' && 'text-label-2 hover:text-label', className)}
      {...rest}
    >
      {children}
    </button>
  )
  if (!tooltip) return button
  return (
    <Tooltip content={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  )
})

/** Converts `mod+shift+k` into the ARIA `aria-keyshortcuts` form, `Meta+Shift+K`. */
export function ariaShortcut(shortcut: string): string {
  const map: Record<string, string> = { mod: 'Meta', shift: 'Shift', alt: 'Alt', ctrl: 'Control' }
  return shortcut
    .split('+')
    .map((k) => map[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k))
    .join('+')
}

/** Inline keyboard shortcut, rendered with macOS glyphs. */
export function Kbd({ shortcut, className }: { shortcut: string; className?: string }) {
  return (
    <kbd className={cn('font-sans text-label-3 tracking-[0.08em] tabular', className)} aria-label={ariaShortcut(shortcut)}>
      {shortcutGlyphs(shortcut)}
    </kbd>
  )
}
