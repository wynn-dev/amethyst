import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn, shortcutGlyphs } from './cn'
import { Tooltip } from './Tooltip'

export type ButtonVariant = 'push' | 'primary' | 'borderless' | 'destructive' | 'link'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl'

const base =
  'relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium select-none ' +
  'transition-[background-color,box-shadow,opacity,color] duration-150 ease-[var(--ease-mac)] ' +
  'disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0'

/*
 * The primary button is filled with the accent: with the default neutral accent that is the text
 * colour (white with dark text in dark mode, near-black with white text in light mode), like the
 * mockup's Play. Push buttons are outlined with a hairline and unfilled.
 */
const variants: Record<ButtonVariant, string> = {
  push: 'text-label hairline-strong hover:bg-hover active:bg-fill data-[state=open]:bg-fill',
  primary: 'bg-accent-fill text-on-accent hover:bg-accent-hover active:brightness-95',
  borderless: 'text-label hover:bg-hover active:bg-fill data-[state=open]:bg-fill',
  destructive: 'bg-red text-white hover:brightness-105 active:brightness-95',
  link: 'text-accent underline decoration-current/35 underline-offset-2 hover:decoration-current !px-0 !h-auto',
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-5 rounded-[5px] px-2 text-small [&_svg]:size-3',
  md: 'h-[26px] rounded-[7px] px-2.5 text-callout [&_svg]:size-3.5',
  lg: 'h-7 rounded-lg px-3 text-compact font-semibold [&_svg]:size-3.5',
  xl: 'h-8 rounded-lg px-4 text-body font-semibold [&_svg]:size-4',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Leading icon (lucide component instance). */
  icon?: ReactNode
}

/** Push button. `primary` is the default button (accent-filled), `borderless` is a toolbar-style button. */
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
  sm: 'size-5 rounded-[5px] [&_svg]:size-[13px]',
  md: 'size-7 rounded-[7px] [&_svg]:size-[15px]',
  lg: 'size-8 rounded-lg [&_svg]:size-4',
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
      className={cn(base, variants[variant], iconSizes[size], variant === 'borderless' && 'text-label-2 hover:text-label data-[state=open]:text-label', className)}
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

/**
 * Inline keyboard shortcut, rendered with macOS glyphs. `boxed` draws the small outlined key cap
 * used as a hint inside fields (the sidebar's ⌘K, the palette's esc).
 */
export function Kbd({ shortcut, className, boxed }: { shortcut: string; className?: string; boxed?: boolean }) {
  return (
    <kbd
      className={cn(
        'font-sans text-label-3 tabular',
        boxed ? 'inline-flex h-4 items-center rounded-[4px] px-[5px] text-[10.5px] font-medium tracking-[0.04em] hairline-strong' : 'tracking-[0.08em]',
        className,
      )}
      aria-label={ariaShortcut(shortcut)}
    >
      {shortcutGlyphs(shortcut)}
    </kbd>
  )
}
