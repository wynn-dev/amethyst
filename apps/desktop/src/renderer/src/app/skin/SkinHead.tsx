import { memo, useEffect, useRef, useState } from 'react'
import { cn } from '@/ui'
import { hasFace, headPixels, normalizeTextureUrl } from '@/lib/skin'
import { makeSkin } from '@/lib/skin-texture'
import { PlayerHead } from '@/app/visuals'

/**
 * A crisp 2D player head (face + hat layer) cut from a skin texture. It is the avatar in account
 * lists and the static fallback of the 3D viewer. No WebGL; one decoded image per URL is cached.
 */

const cache = new Map<string, Promise<Uint8ClampedArray>>()
const CACHE_LIMIT = 48

function loadHead(url: string): Promise<Uint8ClampedArray> {
  let p = cache.get(url)
  if (!p) {
    p = new Promise<Uint8ClampedArray>((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.decoding = 'async'
      img.onload = () => {
        const { naturalWidth: w, naturalHeight: h } = img
        if (w < 64 || (h !== w && h * 2 !== w)) return reject(new Error(`Bad skin size: ${w}x${h}`))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return reject(new Error('No 2D context'))
        ctx.drawImage(img, 0, 0)
        const data = ctx.getImageData(0, 0, w, h).data
        if (!hasFace(data, w)) return reject(new Error('Empty face'))
        resolve(headPixels(data, w, h))
      }
      img.onerror = () => reject(new Error('Image failed to load'))
      img.src = normalizeTextureUrl(url)
    })
    p.catch(() => cache.delete(url))
    cache.set(url, p)
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  }
  return p
}

let defaultHead: Uint8ClampedArray | undefined
const getDefaultHead = () => (defaultHead ??= headPixels(makeSkin().data, 64, 64))

export interface SkinHeadProps {
  /** Skin texture URL (`https:`, `amethyst-asset:` or `data:`); `null` draws the default character. */
  skin: string | null | undefined
  size?: number
  /** Generated-avatar hue to show if the skin can't be loaded. */
  hue?: number
  className?: string
  label?: string
}

export const SkinHead = memo(function SkinHead({ skin, size = 20, hue, className, label }: SkinHeadProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [failedSkin, setFailedSkin] = useState<string | null>(null)
  const failed = !!skin && failedSkin === skin

  useEffect(() => {
    let live = true
    const draw = (pixels: Uint8ClampedArray) => {
      if (live) canvas.current?.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(pixels), 8, 8), 0, 0)
    }
    if (!skin) draw(getDefaultHead())
    else
      loadHead(skin).then(draw, () => {
        draw(getDefaultHead())
        if (live) setFailedSkin(skin)
      })
    return () => {
      live = false
    }
  }, [skin])

  if (failed && hue !== undefined) return <PlayerHead hue={hue} size={size} className={className} />
  return (
    <canvas
      ref={canvas}
      width={8}
      height={8}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
      className={cn('shrink-0 rounded-[3px] bg-fill-2 shadow-[0_0_0_0.5px_rgb(0_0_0/0.2)]', className)}
    />
  )
})
