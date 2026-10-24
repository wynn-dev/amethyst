import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { RadioGroup } from 'radix-ui'
import type { ThemeMode } from '@shared/services'
import { cn } from '@/ui'
import { ACCENT_SWATCHES, applyAccent, normalizeHex } from '@/lib/theme'
import { positioned } from '@/app/visuals'

/** What the miniature shows behind its content: the real media when there is one. */
export interface MiniBackground {
  kind: 'none' | 'image' | 'video'
  url: string | null
  fit?: 'cover' | 'contain'
  blur?: number
  overlay?: boolean
}

/**
 * A miniature of the main window. Colours resolve through the real tokens: forcing
 * `color-scheme` on the frame previews light or dark without touching the app.
 */
export function MiniWindow({
  scheme,
  translucent = true,
  background,
  className,
  style,
}: {
  scheme: 'light' | 'dark'
  translucent?: boolean
  background?: MiniBackground
  className?: string
  style?: CSSProperties
}) {
  const media = background && background.kind !== 'none' && background.url ? background : null
  const mediaClass = cn('absolute inset-0 size-full', media?.fit === 'contain' ? 'object-contain' : 'object-cover')
  // The thumbnail is ~6× smaller than the window, so scale the blur down with it.
  const mediaStyle: CSSProperties | undefined = media?.blur ? { filter: `blur(${Math.max(1, media.blur / 6)}px)`, transform: 'scale(1.08)' } : undefined
  return (
    <div
      aria-hidden
      style={{ colorScheme: scheme, ...style }}
      className={cn(positioned(className), 'overflow-hidden bg-[linear-gradient(135deg,#7c5bd1,#3d6fd6_55%,#2fb59b)]', className)}
    >
      <div className="absolute inset-[9%_7%_0_7%] flex overflow-hidden rounded-t-[5px] shadow-[0_0_0_0.5px_rgb(0_0_0/0.25),0_4px_12px_rgb(0_0_0/0.3)]">
        <div className={cn('flex w-[30%] flex-col gap-[6%] p-[5%]', translucent ? 'bg-window-2/70 backdrop-blur-md' : 'bg-window-2')}>
          <div className="flex gap-[3px]">
            <span className="size-[4px] rounded-full bg-[#ff5f57]" />
            <span className="size-[4px] rounded-full bg-[#febc2e]" />
            <span className="size-[4px] rounded-full bg-[#28c840]" />
          </div>
          <span className="mt-[10%] h-[5px] w-[80%] rounded-[2px] bg-accent" />
          <span className="h-[4px] w-[65%] rounded-[2px] bg-label-4" />
          <span className="h-[4px] w-[72%] rounded-[2px] bg-label-4" />
          <span className="h-[4px] w-[55%] rounded-[2px] bg-label-4" />
        </div>
        <div className="relative flex flex-1 flex-col gap-[7%] overflow-hidden bg-window p-[6%]">
          {media && (
            <>
              {media.kind === 'image' ? (
                <img src={media.url!} alt="" decoding="async" className={mediaClass} style={mediaStyle} />
              ) : (
                <video src={media.url!} muted preload="metadata" playsInline className={mediaClass} style={mediaStyle} />
              )}
              {media.overlay !== false && <div className="absolute inset-0 bg-window opacity-70" />}
            </>
          )}
          <span className="relative h-[5px] w-[45%] rounded-[2px] bg-label-3" />
          <div className="relative flex gap-[6%]">
            <span className="aspect-square w-[28%] rounded-[3px] bg-fill-3" />
            <span className="aspect-square w-[28%] rounded-[3px] bg-fill-3" />
            <span className="aspect-square w-[28%] rounded-[3px] bg-fill-3" />
          </div>
          <span className="relative h-[4px] w-[70%] rounded-[2px] bg-label-4" />
          <span className="relative mt-auto h-[7px] w-[30%] self-end rounded-[3px] bg-accent" />
        </div>
      </div>
    </div>
  )
}

const MODES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'Automatic' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/** System / Light / Dark as window thumbnails (B8, B10.2). */
export function ModePicker({ value, onValueChange, size = 'md' }: { value: ThemeMode; onValueChange: (v: ThemeMode) => void; size?: 'md' | 'lg' }) {
  const w = size === 'lg' ? 'w-[120px] h-[78px]' : 'w-[84px] h-[56px]'
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(v) => onValueChange(v as ThemeMode)}
      aria-label="Appearance"
      orientation="horizontal"
      className="flex gap-4"
    >
      {MODES.map((m) => (
        <RadioGroup.Item key={m.value} value={m.value} aria-label={m.label} className="group flex flex-col items-center gap-1.5 rounded-lg outline-none">
          <span
            className={cn(
              'relative block overflow-hidden rounded-[7px] ring-offset-2 ring-offset-[var(--color-window)] transition-shadow duration-150',
              w,
              'shadow-[0_0_0_0.5px_rgb(0_0_0/0.2)] group-data-[state=checked]:ring-[3px] group-data-[state=checked]:ring-accent',
              'group-focus-visible:ring-[3px] group-focus-visible:ring-[color-mix(in_srgb,var(--accent)_55%,transparent)]',
            )}
          >
            {m.value === 'system' ? (
              <>
                <MiniWindow scheme="light" className="absolute inset-0" />
                <MiniWindow scheme="dark" className="absolute inset-0" style={{ clipPath: 'polygon(55% 0, 100% 0, 100% 100%, 45% 100%)' }} />
              </>
            ) : (
              <MiniWindow scheme={m.value} className="absolute inset-0" />
            )}
          </span>
          <span className="text-small text-label group-data-[state=checked]:font-semibold">{m.label}</span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}

const CUSTOM = 'custom'
const RAINBOW = 'conic-gradient(from 180deg, #ff3b30, #ff9500, #ffcc00, #34c759, #007aff, #af52de, #ff3b30)'

function Swatch({ id, label, background, labels, onClick }: { id: string; label: string; background: string; labels: boolean; onClick?: () => void }) {
  return (
    <RadioGroup.Item value={id} aria-label={label} title={label} onClick={onClick} className="group flex flex-col items-center gap-1 rounded-full outline-none">
      <span
        className={cn(
          'flex size-[18px] items-center justify-center rounded-full shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.2)]',
          'group-focus-visible:ring-[3px] group-focus-visible:ring-[color-mix(in_srgb,var(--accent)_55%,transparent)]',
        )}
        style={{ background }}
      >
        <span className="size-[6px] scale-0 rounded-full bg-white transition-transform duration-150 group-data-[state=checked]:scale-100" />
      </span>
      {labels && <span className="text-caption text-label-2 group-data-[state=checked]:text-label">{label}</span>}
    </RadioGroup.Item>
  )
}

/**
 * Accent swatches plus "Custom…", which opens the native colour panel (B8). Dragging in the panel
 * previews live through the CSS variable; the value is saved once the colour settles.
 */
export function AccentPicker({ value, onValueChange, labels = false }: { value: string; onValueChange: (v: string) => void; labels?: boolean }) {
  const hex = normalizeHex(value) ?? ACCENT_SWATCHES[0]!.color
  const colorInput = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The colour being dragged in the panel, until it is saved.
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const swatch = draft ? undefined : ACCENT_SWATCHES.find((a) => a.color === hex)
  const custom = draft ?? (swatch ? null : hex)

  const pickCustom = (next: string) => {
    setDraft(next)
    applyAccent(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      onValueChange(next)
      setDraft(null)
    }, 300)
  }
  const openPanel = () => colorInput.current?.click()

  return (
    <div className="flex flex-col items-start gap-1">
      <RadioGroup.Root
        value={swatch ? swatch.color : CUSTOM}
        onValueChange={(v) => {
          if (v !== CUSTOM) onValueChange(v)
        }}
        aria-label="Accent colour"
        orientation="horizontal"
        loop
        className={cn('flex items-start', labels ? 'gap-3' : 'gap-2')}
      >
        {ACCENT_SWATCHES.map((a) => (
          <Swatch key={a.color} id={a.color} label={a.label} labels={labels} background={a.label === 'Amethyst' ? 'linear-gradient(135deg,#b48bf0,#7a43c9)' : a.color} />
        ))}
        <Swatch id={CUSTOM} label="Custom…" labels={labels} background={custom ?? RAINBOW} onClick={openPanel} />
      </RadioGroup.Root>
      <input
        ref={colorInput}
        type="color"
        aria-label="Custom accent colour"
        tabIndex={-1}
        value={custom ?? hex}
        onChange={(e) => pickCustom(e.target.value)}
        className="pointer-events-none absolute size-0 opacity-0"
      />
      {!labels && <span className="text-small text-label-2">{swatch?.label ?? 'Custom'}</span>}
    </div>
  )
}
