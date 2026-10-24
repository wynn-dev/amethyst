import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classFile, CPU_ARM64, CPU_X86_64, fatMachO, put, tempDir, thinMachO } from './__fixtures__/helpers'
import { machOArch, parseMachOHeader, readMachO } from './macho'
import { normalizeArch, parseReleaseFile, readReleaseFile } from './release'
import { compareJavaVersions, parseJavaVersion, parseVersionBanner } from './version'

const v = (s: string) => parseJavaVersion(s)!

describe('parseJavaVersion', () => {
  it.each([
    ['1.8.0_512', 8, [8, 0, 512]],
    ['1.8.0_452-b09', 8, [8, 0, 452]],
    ['1.8', 8, [8, 0, 0]],
    ['17.0.15', 17, [17, 0, 15]],
    ['17.0.20.1', 17, [17, 0, 20, 1]],
    ['21.0.7+6-LTS', 21, [21, 0, 7]],
    ['25', 25, [25]],
    ['26-ea', 26, [26]],
    ['27+35-2325', 27, [27]],
    ['8u74-cacert462b08', 8, [8, 0, 74]],
    ['16.0.1.9.1_3', 16, [16, 0, 1, 9]],
    ['"11.0.2"', 11, [11, 0, 2]],
  ])('%s -> %i', (input, major, parts) => {
    expect(parseJavaVersion(input)).toMatchObject({ majorVersion: major, parts })
  })

  it('rejects non-versions', () => {
    expect(parseJavaVersion('')).toBeUndefined()
    expect(parseJavaVersion('openjdk')).toBeUndefined()
    expect(parseJavaVersion('0.1')).toBeUndefined()
  })

  it('orders versions numerically', () => {
    expect(compareJavaVersions(v('17.0.15'), v('17.0.9'))).toBeGreaterThan(0)
    expect(compareJavaVersions(v('1.8.0_512'), v('1.8.0_452'))).toBeGreaterThan(0)
    expect(compareJavaVersions(v('21'), v('21.0.0'))).toBe(0)
  })
})

describe('parseVersionBanner', () => {
  it('reads -version banners, skipping "Picked up" lines', () => {
    expect(parseVersionBanner('openjdk version "17.0.15" 2025-04-15\nOpenJDK Runtime Environment')?.majorVersion).toBe(17)
    expect(parseVersionBanner('java version "1.8.0_452"\nJava(TM) SE Runtime Environment')?.version).toBe('1.8.0_452')
    expect(parseVersionBanner('openjdk version "25" 2025-09-16')?.majorVersion).toBe(25)
    expect(parseVersionBanner('Picked up JAVA_TOOL_OPTIONS: -Dfoo=1.2.3 -Djava version "9.9.9"\nopenjdk version "21.0.7" 2025-04-15')?.version).toBe('21.0.7')
    expect(parseVersionBanner('JAVA_VERSION="21"')?.majorVersion).toBe(21)
    expect(parseVersionBanner('Unable to locate a Java Runtime.')).toBeUndefined()
  })
})

describe('release file', () => {
  it('parses quoted values and odd lines', () => {
    const info = parseReleaseFile(
      ['IMPLEMENTOR="Azul Systems, Inc."', 'JAVA_VERSION="1.8.0_512"', 'OS_ARCH="aarch64"', "SOURCE='.:git:8bd08fd5b83d'", 'MODULES="java.base java.xml"', 'junk line', '# comment', 'EMPTY=', ''].join('\n'),
    )
    expect(info).toEqual({
      IMPLEMENTOR: 'Azul Systems, Inc.',
      JAVA_VERSION: '1.8.0_512',
      OS_ARCH: 'aarch64',
      SOURCE: '.:git:8bd08fd5b83d',
      MODULES: 'java.base java.xml',
      EMPTY: '',
    })
  })

  it('reads <home>/release and tolerates its absence', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      await put(join(dir, 'release'), 'JAVA_VERSION="21.0.7"\r\nOS_ARCH="x86_64"\r\n')
      expect(await readReleaseFile(dir)).toEqual({ JAVA_VERSION: '21.0.7', OS_ARCH: 'x86_64' })
      expect(await readReleaseFile(join(dir, 'nope'))).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('maps os.arch / OS_ARCH values', () => {
    expect(normalizeArch('aarch64')).toBe('arm64')
    expect(normalizeArch('arm64')).toBe('arm64')
    expect(normalizeArch('x86_64')).toBe('x64')
    expect(normalizeArch('amd64')).toBe('x64')
    expect(normalizeArch('ppc64le')).toBe('unknown')
    expect(normalizeArch(undefined)).toBe('unknown')
  })
})

describe('Mach-O header', () => {
  it('detects thin arm64, arm64e and x86_64', () => {
    expect(parseMachOHeader(thinMachO(CPU_ARM64))).toEqual({ kind: 'thin', archs: ['arm64'] })
    expect(parseMachOHeader(thinMachO(CPU_ARM64, 2))).toEqual({ kind: 'thin', archs: ['arm64e'] })
    expect(parseMachOHeader(thinMachO(CPU_X86_64))).toEqual({ kind: 'thin', archs: ['x86_64'] })
    expect(machOArch(parseMachOHeader(thinMachO(CPU_X86_64))!)).toBe('x64')
    expect(machOArch(parseMachOHeader(thinMachO(CPU_ARM64))!)).toBe('arm64')
  })

  it('detects universal binaries and prefers the native slice', () => {
    const fat = fatMachO([CPU_X86_64, CPU_ARM64])
    const info = parseMachOHeader(fat, fat.length)!
    expect(info).toEqual({ kind: 'fat', archs: ['x86_64', 'arm64'] })
    expect(machOArch(info, 'arm64')).toBe('arm64')
    expect(machOArch(info, 'x64')).toBe('x64')
    expect(machOArch(parseMachOHeader(fatMachO([CPU_X86_64]))!, 'arm64')).toBe('x64')
  })

  it('does not mistake Java class files, scripts or truncated data for Mach-O', () => {
    expect(parseMachOHeader(classFile())).toBeUndefined()
    expect(parseMachOHeader(Buffer.from('#!/bin/sh\nexec java "$@"\n'))).toBeUndefined()
    expect(parseMachOHeader(Buffer.from([0xcf, 0xfa]))).toBeUndefined()
    // A fat table whose slices lie outside the file is rejected.
    const fat = fatMachO([CPU_ARM64])
    expect(parseMachOHeader(fat, 100)).toBeUndefined()
    // Unknown CPU type.
    expect(parseMachOHeader(thinMachO(0x42))).toBeUndefined()
  })

  it('reads the header from disk', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      await put(join(dir, 'java'), fatMachO([CPU_X86_64, CPU_ARM64]))
      await put(join(dir, 'Main.class'), classFile())
      expect(await readMachO(join(dir, 'java'))).toEqual({ kind: 'fat', archs: ['x86_64', 'arm64'] })
      expect(await readMachO(join(dir, 'Main.class'))).toBeUndefined()
      expect(await readMachO(join(dir, 'missing'))).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it.runIf(process.platform === 'darwin')('reads real system binaries', async () => {
    // /usr/bin/java is the universal Apple stub (x86_64 + arm64e).
    const stub = await readMachO('/usr/bin/java')
    expect(stub?.kind).toBe('fat')
    expect(stub?.archs).toContain('x86_64')
  })
})
