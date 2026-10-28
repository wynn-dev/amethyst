/**
 * Generated media for the dev-only screenshot mode (no binary fixtures in the repo).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

/** Encodes 8-bit RGB pixels as a PNG. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0 // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1)
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit, truecolour
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** A sunset landscape: a sky gradient, a sun and two rows of hills. */
export function landscape(width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3)
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i]! - v) * t))
  const sky = [
    [44, 52, 120],
    [168, 92, 160],
    [248, 172, 110],
  ]
  for (let y = 0; y < height; y++) {
    const t = y / height
    const skyColor = t < 0.5 ? mix(sky[0]!, sky[1]!, t / 0.5) : mix(sky[1]!, sky[2]!, Math.min(1, (t - 0.5) / 0.25))
    for (let x = 0; x < width; x++) {
      const far = height * (0.62 + 0.05 * Math.sin(x / 90) + 0.03 * Math.sin(x / 37))
      const near = height * (0.74 + 0.06 * Math.sin(x / 140 + 2) + 0.02 * Math.sin(x / 23))
      const sun = Math.hypot(x - width * 0.68, y - height * 0.52) < height * 0.09
      let c = sun ? [255, 224, 150] : skyColor
      if (y > far) c = mix([84, 60, 120], [60, 44, 96], (y - far) / height)
      if (y > near) c = mix([40, 70, 80], [20, 36, 44], (y - near) / (height * 0.3))
      rgb.set(c, (y * width + x) * 3)
    }
  }
  return rgb
}

/** Writes the background fixture and returns its absolute path. */
export async function writeBackgroundFixture(dir: string): Promise<string> {
  const folder = join(dir, '.fixtures')
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'background.png')
  await writeFile(file, encodePng(1200, 780, landscape(1200, 780)))
  return file
}

/** Sample mods for the screenshots: [name, author, version]. */
const SAMPLE_MODS: [string, string, string][] = [
  ['Sodium', 'CaffeineMC', '0.6.3'],
  ['Iris Shaders', 'coderbot', '1.8.1'],
  ['Lithium', 'CaffeineMC', '0.14.3'],
  ['Fabric API', 'FabricMC', '0.107.0'],
  ['Mod Menu', 'Prospector', '11.0.3'],
  ["Xaero's Minimap", 'xaero96', '24.6.1'],
  ["Xaero's World Map", 'xaero96', '1.39.2'],
  ['Jade', 'Snownee', '15.8.2'],
  ['AppleSkin', 'squeek502', '3.0.5'],
  ['Entity Culling', 'tr7zw', '1.7.2'],
  ['ImmediatelyFast', 'RaphiMC', '1.3.3'],
  ['FerriteCore', 'malte0811', '7.0.2'],
  ['Krypton', 'astei', '0.2.8'],
  ['Continuity', 'PepperCode1', '3.0.0'],
  ['Zoomify', 'isXander', '2.14.2'],
  ['Sound Physics Remastered', 'henkelmax', '1.4.8'],
  ['Cloth Config', 'shedaniel', '15.0.140'],
  ['YetAnotherConfigLib', 'isXander', '3.6.1'],
]

/** Writes small Fabric mod jars (metadata only) and returns their absolute paths. */
export async function writeModFixtures(dir: string): Promise<string[]> {
  const { createZip } = await import('@amethyst/zip')
  const folder = join(dir, '.fixtures', 'mods')
  await mkdir(folder, { recursive: true })
  const files: string[] = []
  for (const [name, author, version] of SAMPLE_MODS) {
    const id = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')
    const file = join(folder, `${id}-${version}.jar`)
    const zip = createZip(file)
    zip.addBuffer(Buffer.from(JSON.stringify({ schemaVersion: 1, id: id.replaceAll('-', '_'), version, name, authors: [author] })), 'fabric.mod.json')
    // oxlint-disable-next-line no-await-in-loop -- a few tiny files, written in order
    await zip.finish()
    files.push(file)
  }
  return files
}
