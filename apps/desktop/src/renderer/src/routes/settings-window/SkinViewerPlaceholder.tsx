import { Box } from 'lucide-react'
import { PlayerHead } from '@/app/visuals'

/**
 * Stand-in for the 3D skin viewer (B9). It is loaded lazily, so when the real viewer (and its
 * WebGL dependency) replaces this file, it stays out of the entry bundle.
 */
export default function SkinViewerPlaceholder({ hue, model, cape }: { hue: number; model: 'classic' | 'slim'; cape: string | null }) {
  return (
    <div
      role="img"
      aria-label={`Skin preview, ${model} model${cape ? ', with cape' : ''}`}
      className="relative flex size-full flex-col items-center justify-center gap-3 overflow-hidden rounded-lg bg-[radial-gradient(ellipse_at_50%_35%,var(--color-fill-2),transparent_70%)] shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]"
    >
      <div className="flex flex-col items-center">
        <PlayerHead hue={hue} size={56} />
        <div className="mt-1 flex gap-0.5">
          <span className={model === 'slim' ? 'h-16 w-2.5 rounded-sm bg-fill-3' : 'h-16 w-3.5 rounded-sm bg-fill-3'} />
          <span className="h-16 w-10 rounded-sm bg-fill-3" />
          <span className={model === 'slim' ? 'h-16 w-2.5 rounded-sm bg-fill-3' : 'h-16 w-3.5 rounded-sm bg-fill-3'} />
        </div>
        <div className="mt-0.5 flex gap-0.5">
          <span className="h-14 w-[19px] rounded-sm bg-fill-2" />
          <span className="h-14 w-[19px] rounded-sm bg-fill-2" />
        </div>
      </div>
      <p className="flex items-center gap-1 text-small text-label-3">
        <Box className="size-3" /> 3D viewer loads here
      </p>
    </div>
  )
}
