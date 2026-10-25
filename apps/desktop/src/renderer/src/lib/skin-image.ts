/** DOM helpers for skin images (decoding pixels in the renderer; nothing goes over IPC). */
import { normalizeTextureUrl } from './skin'

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The image couldn’t be loaded.'))
    img.src = normalizeTextureUrl(url)
  })
}

function draw(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d', { willReadFrequently: true })?.drawImage(img, 0, 0)
  return canvas
}

/** Decodes an image URL to RGBA pixels. */
export async function decodePixels(url: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const canvas = draw(await loadImage(url))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('No 2D context')
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height }
}

/** Re-encodes an image (e.g. a launcher-only `amethyst-asset:` skin) as a PNG data URL. */
export async function imageToDataUrl(url: string): Promise<string> {
  return draw(await loadImage(url)).toDataURL('image/png')
}
