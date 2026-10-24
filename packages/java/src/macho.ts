import { open } from 'node:fs/promises'
import type { JavaArch } from './types'

/**
 * Mach-O header inspection, so a JVM's architecture is known without spawning it.
 *
 * Thin binaries start with `MH_MAGIC_64` (`0xFEEDFACF`, stored little-endian on disk) followed by
 * the cputype. Universal binaries start with `FAT_MAGIC` (`0xCAFEBABE`, big-endian) and a table of
 * `fat_arch` records. `0xCAFEBABE` is also the magic of Java class files, so a fat header is only
 * accepted when its arch count is small and every record is plausible.
 */

/** Architectures found in a Mach-O, as printed by `lipo -archs` (`arm64`, `arm64e`, `x86_64`...). */
export interface MachOInfo {
  kind: 'thin' | 'fat'
  archs: string[]
}

const MH_MAGIC = 0xfeedface
const MH_MAGIC_64 = 0xfeedfacf
const MH_CIGAM = 0xcefaedfe
const MH_CIGAM_64 = 0xcffaedfe
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf

const CPU_ARCH_ABI64 = 0x01000000
const CPU_TYPE_X86 = 7
const CPU_TYPE_ARM = 12
const CPU_TYPE_POWERPC = 18
const CPU_SUBTYPE_MASK = 0x00ffffff
const CPU_SUBTYPE_ARM64E = 2

/** Bytes read from the start of a file; enough for any realistic fat table. */
export const MACHO_PROBE_BYTES = 4096
/** Real universal binaries have a handful of slices; Java class files would claim 45+. */
const MAX_FAT_ARCHS = 20

/** Name a `(cputype, cpusubtype)` pair, or `undefined` for CPUs we do not recognise. */
export function cpuName(cputype: number, cpusubtype: number): string | undefined {
  const sub = cpusubtype & CPU_SUBTYPE_MASK
  switch (cputype >>> 0) {
    case (CPU_TYPE_ARM | CPU_ARCH_ABI64) >>> 0:
      return sub === CPU_SUBTYPE_ARM64E ? 'arm64e' : 'arm64'
    case (CPU_TYPE_X86 | CPU_ARCH_ABI64) >>> 0:
      return 'x86_64'
    case CPU_TYPE_X86:
      return 'i386'
    case CPU_TYPE_ARM:
      return 'arm'
    case 0x0200000c:
      return 'arm64_32'
    case CPU_TYPE_POWERPC:
      return 'ppc'
    case (CPU_TYPE_POWERPC | CPU_ARCH_ABI64) >>> 0:
      return 'ppc64'
    default:
      return undefined
  }
}

/**
 * Parse the first bytes of a file as a Mach-O header. Returns `undefined` for anything that is
 * not a thin or universal Mach-O (shell scripts, Java class files, truncated input).
 *
 * @param fileSize when known, fat slices must lie inside the file.
 */
export function parseMachOHeader(bytes: Uint8Array, fileSize?: number): MachOInfo | undefined {
  if (bytes.length < 8) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const be = view.getUint32(0, false)

  if (be === FAT_MAGIC || be === FAT_MAGIC_64) {
    const wide = be === FAT_MAGIC_64
    const count = view.getUint32(4, false)
    const recordSize = wide ? 32 : 20
    if (count < 1 || count > MAX_FAT_ARCHS || 8 + count * recordSize > bytes.length) return undefined
    const archs: string[] = []
    for (let i = 0; i < count; i++) {
      const at = 8 + i * recordSize
      const name = cpuName(view.getUint32(at, false), view.getUint32(at + 4, false))
      const offset = wide ? Number(view.getBigUint64(at + 8, false)) : view.getUint32(at + 8, false)
      const size = wide ? Number(view.getBigUint64(at + 16, false)) : view.getUint32(at + 12, false)
      if (!name || offset < 8 + count * recordSize || size === 0) return undefined
      if (fileSize !== undefined && offset + size > fileSize) return undefined
      archs.push(name)
    }
    return { kind: 'fat', archs }
  }

  const le = view.getUint32(0, true)
  let little: boolean
  if (le === MH_MAGIC || le === MH_MAGIC_64) little = true
  else if (le === MH_CIGAM || le === MH_CIGAM_64) little = false
  else return undefined
  const name = cpuName(view.getUint32(4, little), view.getUint32(8, little))
  if (!name) return undefined
  return { kind: 'thin', archs: [name] }
}

/** Read the Mach-O header of a file. Returns `undefined` when it is not a Mach-O or unreadable. */
export async function readMachO(path: string): Promise<MachOInfo | undefined> {
  let fh
  try {
    fh = await open(path, 'r')
    const { size } = await fh.stat()
    const buf = Buffer.alloc(Math.min(MACHO_PROBE_BYTES, size))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return parseMachOHeader(buf.subarray(0, bytesRead), size)
  } catch {
    return undefined
  } finally {
    await fh?.close()
  }
}

/**
 * The architecture a Mach-O actually runs as on a host. A universal binary runs its native
 * slice when it has one, so on Apple Silicon a fat `x86_64 + arm64` JVM is an arm64 JVM.
 */
export function machOArch(info: MachOInfo, host: 'arm64' | 'x64' = 'arm64'): JavaArch {
  const hasArm = info.archs.some((a) => a === 'arm64' || a === 'arm64e')
  const hasX64 = info.archs.includes('x86_64')
  if (host === 'arm64' && hasArm) return 'arm64'
  if (hasX64) return 'x64'
  if (hasArm) return 'arm64'
  return 'unknown'
}
