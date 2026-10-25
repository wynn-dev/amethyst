import { Component, lazy, Suspense, type ReactNode } from 'react'
import { cn } from '@/ui'
import type { SkinModel } from '@/lib/skin'
import { SkinHead } from './SkinHead'

export interface SkinViewerProps {
  /** Skin texture URL (`https:`, `amethyst-asset:` or `data:`); `null` shows the default character. */
  skin: string | null
  model: SkinModel
  /** Cape texture URL, or `null` for none. */
  cape: string | null
  animation?: 'idle' | 'walk' | 'none'
  /** Stops the frame loop without disposing the viewer (e.g. while a game runs). */
  paused?: boolean
  /** A texture failed to load; the message is user-facing. */
  onError?: (message: string) => void
  className?: string
}

// three.js + skinview3d are ~150 KB compressed: a lazy chunk, never in the entry.
const SkinViewer3D = lazy(() => import('./SkinViewer3D'))

let webglSupport: boolean | undefined
/** Probes WebGL once per window and releases the probe context right away. */
function hasWebGL(): boolean {
  if (webglSupport === undefined) {
    try {
      const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
      webglSupport = !!gl
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      webglSupport = false
    }
  }
  return webglSupport
}

/** The static 2D head shown while the 3D chunk loads, and instead of it when WebGL is unavailable. */
export function SkinFallback({ skin, note }: { skin: string | null; note?: string }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3">
      <SkinHead skin={skin} size={88} className="rounded-md shadow-card" />
      {note && <p className="px-3 text-center text-small text-label-3">{note}</p>}
    </div>
  )
}

class ViewerBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * The 3D skin viewer (B9, accounts.md §9) with its fallbacks. Drag to rotate; idles while visible.
 */
export function SkinViewer(props: SkinViewerProps) {
  const label = `Skin preview, ${props.model === 'slim' ? 'slim' : 'classic'} model${props.cape ? ', with cape' : ''}`
  const unavailable = <SkinFallback skin={props.skin} note="3D preview isn’t available on this Mac." />
  return (
    <div
      role="img"
      aria-label={label}
      className={cn(
        'relative size-full overflow-hidden rounded-lg bg-[radial-gradient(ellipse_at_50%_38%,var(--color-fill-2),transparent_72%)] shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]',
        props.className,
      )}
    >
      {hasWebGL() ? (
        <ViewerBoundary fallback={unavailable}>
          <Suspense fallback={<SkinFallback skin={props.skin} />}>
            <SkinViewer3D {...props} className="size-full" />
          </Suspense>
        </ViewerBoundary>
      ) : (
        unavailable
      )}
    </div>
  )
}
