import type { CSSProperties, ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, XOctagon } from 'lucide-react'
import { cn } from './cn'

/* ------------------------------------------------------------------------------------------ */
/* Banner                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export type Tone = 'info' | 'success' | 'warning' | 'error' | 'neutral'

const toneText: Record<Tone, string> = {
  info: 'text-label-2',
  success: 'text-green',
  warning: 'text-orange',
  error: 'text-red',
  neutral: 'text-label-2',
}
/* Status reads from the icon and a faint tint only where it matters (warnings, errors). */
const toneBg: Record<Tone, string> = {
  info: 'bg-fill',
  success: 'bg-fill',
  warning: 'bg-[color-mix(in_srgb,var(--color-orange)_8%,transparent)]',
  error: 'bg-[color-mix(in_srgb,var(--color-red)_8%,transparent)]',
  neutral: 'bg-fill',
}
const toneIcon: Record<Tone, ReactNode> = {
  info: <Info />,
  success: <CheckCircle2 />,
  warning: <AlertTriangle />,
  error: <XOctagon />,
  neutral: <Info />,
}

export interface BannerProps {
  tone?: Tone
  title: ReactNode
  children?: ReactNode
  /** Trailing actions (buttons). */
  actions?: ReactNode
  icon?: ReactNode
  className?: string
}

/** An inline, persistent message. Persistent problems live here, never only in a toast. */
export function Banner({ tone = 'info', title, children, actions, icon, className }: BannerProps) {
  return (
    <div
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
      className={cn('flex items-center gap-2.5 rounded-lg px-3 py-2 hairline', toneBg[tone], className)}
    >
      <span className={cn('flex shrink-0 [&_svg]:size-4', toneText[tone])}>{icon ?? toneIcon[tone]}</span>
      <div className="min-w-0 flex-1">
        <p className="text-compact font-medium">{title}</p>
        {children && <div className="text-meta text-label-2">{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Progress                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface ProgressBarProps {
  /** 0–1. Omit for an indeterminate bar. */
  value?: number
  label: string
  size?: 'xs' | 'sm' | 'md'
  tone?: 'accent' | 'red' | 'green' | 'label'
  className?: string
}

const barTone = { accent: 'bg-accent', red: 'bg-red', green: 'bg-green', label: 'bg-label-2' }

export function ProgressBar({ value, label, size = 'sm', tone = 'accent', className }: ProgressBarProps) {
  const determinate = value !== undefined
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(value * 100) : undefined}
      className={cn(
        'relative w-full overflow-hidden rounded-full bg-fill',
        size === 'xs' ? 'h-[3px]' : size === 'sm' ? 'h-1' : 'h-1.5',
        className,
      )}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-300 ease-[var(--ease-mac)]', barTone[tone], !determinate && 'w-1/3 animate-shimmer')}
        style={determinate ? { width: `${Math.max(0, Math.min(1, value)) * 100}%` } : undefined}
      />
    </div>
  )
}

export interface ProgressRingProps {
  /** 0–1. Omit for a spinner. */
  value?: number
  size?: number
  stroke?: number
  label?: string
  className?: string
}

/** Circular progress, or a spinner when indeterminate. */
export function ProgressRing({ value, size = 16, stroke = 2, label, className }: ProgressRingProps) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const determinate = value !== undefined
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role={label ? 'progressbar' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      aria-valuenow={determinate && label ? Math.round(value * 100) : undefined}
      className={cn('shrink-0 -rotate-90', !determinate && 'animate-spin', className)}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-fill-3" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={determinate ? c * (1 - Math.max(0, Math.min(1, value))) : c * 0.72}
        className="stroke-accent transition-[stroke-dashoffset] duration-300"
      />
    </svg>
  )
}

/** Indeterminate spinner (12 spokes). */
export function Spinner({ size = 16, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('shrink-0 animate-[spin_1s_steps(12)_infinite] text-label-2', className)}
    >
      {Array.from({ length: 12 }, (_, i) => (
        <rect
          key={i}
          x="11"
          y="2"
          width="2"
          height="6"
          rx="1"
          fill="currentColor"
          opacity={0.18 + (i / 12) * 0.82}
          transform={`rotate(${i * 30} 12 12)`}
        />
      ))}
    </svg>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Badge                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface BadgeProps {
  tone?: Tone | 'accent'
  children: ReactNode
  className?: string
  title?: string
}

const badgeTone: Record<Tone | 'accent', string> = {
  info: 'hairline-strong',
  success: 'bg-[color-mix(in_srgb,var(--color-green)_12%,transparent)]',
  warning: 'bg-[color-mix(in_srgb,var(--color-orange)_12%,transparent)]',
  error: 'bg-[color-mix(in_srgb,var(--color-red)_12%,transparent)]',
  neutral: 'hairline-strong',
  accent: 'bg-accent-soft',
}
const badgeText: Record<Tone | 'accent', string> = { ...toneText, info: 'text-label-2', neutral: 'text-label-2', accent: 'text-accent' }

/** Small outlined label (source, status, version tags). Status tones get a faint tint. */
export function Badge({ tone = 'neutral', children, className, title }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-4 shrink-0 items-center gap-1 rounded-[4px] px-1.5 text-[10.5px] font-medium whitespace-nowrap [&_svg]:size-2.5',
        badgeTone[tone],
        badgeText[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** A small status dot, e.g. "running". `pulse` adds the running ring (the one looping animation). */
export function Dot({ tone = 'green', label, pulse }: { tone?: 'green' | 'orange' | 'red' | 'accent' | 'gray'; label: string; pulse?: boolean }) {
  const bg = { green: 'bg-green', orange: 'bg-orange', red: 'bg-red', accent: 'bg-accent', gray: 'bg-gray' }[tone]
  const ring = { green: 'border-green', orange: 'border-orange', red: 'border-red', accent: 'border-accent', gray: 'border-gray' }[tone]
  return (
    <span role="img" aria-label={label} className={cn('relative inline-block size-1.5 shrink-0 rounded-full', bg)}>
      {pulse && <span aria-hidden className={cn('absolute -inset-[3px] animate-ring rounded-full border', ring)} />}
    </span>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Empty state                                                                                */
/* ------------------------------------------------------------------------------------------ */

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  actions?: ReactNode
  className?: string
  size?: 'md' | 'lg'
}

export function EmptyState({ icon, title, description, actions, className, size = 'md' }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-1 flex-col items-center justify-center px-8 py-12 text-center', className)}>
      {icon && (
        <div className={cn('mb-3 flex items-center justify-center text-label-3', size === 'lg' ? '[&_svg]:size-10' : '[&_svg]:size-7')} aria-hidden>
          {icon}
        </div>
      )}
      <h2 className={cn('font-semibold text-label', size === 'lg' ? 'text-title2' : 'text-headline')}>{title}</h2>
      {description && <p className="mt-1 max-w-[380px] text-compact text-label-2">{description}</p>}
      {actions && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Skeleton                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden className={cn('animate-shimmer rounded-[4px] bg-fill', className)} style={style} />
}

/** A run of skeleton table rows for loading lists. */
export function SkeletonRows({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cn('flex flex-col', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-8 items-center gap-3 px-4">
          <Skeleton className="size-[18px] rounded-[5px]" />
          <Skeleton className="h-2.5" style={{ width: `${28 + ((i * 37) % 30)}%` }} />
          <Skeleton className="ml-auto h-2.5 w-16" />
        </div>
      ))}
    </div>
  )
}
