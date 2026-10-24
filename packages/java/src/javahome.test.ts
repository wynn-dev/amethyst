import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURES, put, tempDir } from './__fixtures__/helpers'
import { listJavaHomes, parseJavaHomeV, parseJavaHomeX, parsePlist } from './javahome'

describe('parseJavaHomeV', () => {
  it('parses the current format, including odd vendors and names', async () => {
    const entries = parseJavaHomeV(await readFile(join(FIXTURES, 'java_home-V.txt'), 'utf8'))
    expect(entries).toHaveLength(9)
    expect(entries[0]).toEqual({
      version: '27',
      arch: 'arm64',
      vendor: 'Oracle Corporation',
      name: 'OpenJDK 27',
      home: '/Users/me/Library/Java/JavaVirtualMachines/openjdk-27/Contents/Home',
    })
    expect(entries.map((e) => e.vendor)).toEqual([
      'Oracle Corporation',
      'Eclipse Adoptium',
      'Amazon.com Inc.',
      'Azul Systems, Inc.',
      'International Business Machines Corporation',
      'GraalVM Community',
      'BellSoft',
      'Oracle Corporation',
      'Oracle Corporation',
    ])
    const semeru = entries[4]
    expect(semeru).toMatchObject({ arch: 'x64', name: 'IBM Semeru Runtime Open Edition 17 (OpenJ9)', version: '17.0.12' })
    // A home with spaces (the applet plug-in) and one with quotes in the path.
    expect(entries[7]?.home).toBe('/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home')
    expect(entries[8]?.home).toBe('/Users/me/Library/Java/JavaVirtualMachines/openjdk-26-ea "early access"/Contents/Home')
    expect(entries[6]).toMatchObject({ version: '1.8.0_452', arch: 'arm64', vendor: 'BellSoft' })
  })

  it('parses the pre-Big Sur format', async () => {
    const entries = parseJavaHomeV(await readFile(join(FIXTURES, 'java_home-V-legacy.txt'), 'utf8'))
    expect(entries).toEqual([
      { version: '11.0.2', arch: 'x64', name: 'OpenJDK 11.0.2', home: '/Library/Java/JavaVirtualMachines/openjdk-11.0.2.jdk/Contents/Home' },
      { version: '1.8.0_292', arch: 'x64', name: 'AdoptOpenJDK 8', home: '/Library/Java/JavaVirtualMachines/adoptopenjdk-8.jdk/Contents/Home' },
      { version: '1.8.0_202', arch: 'x64', name: 'Java SE 8', home: '/Library/Java/JavaVirtualMachines/jdk1.8.0_202.jdk/Contents/Home' },
    ])
  })

  it('falls back to version + trailing path for unknown layouts and ignores noise', () => {
    const text = [
      'Matching Java Virtual Machines (2):',
      '    22.0.1 [arm64] "Some Vendor" /opt/jdks/some-22/Contents/Home',
      '    not a version line',
      'Unable to find any JVMs matching version "(null)".',
      '',
    ].join('\n')
    expect(parseJavaHomeV(text)).toEqual([{ version: '22.0.1', home: '/opt/jdks/some-22/Contents/Home' }])
    expect(parseJavaHomeV('Unable to find any JVMs matching version "(null)".\nNo Java runtime present, try --request to install.\n')).toEqual([])
    expect(parseJavaHomeV('')).toEqual([])
  })
})

describe('parseJavaHomeX', () => {
  it('reads JVM dicts from the plist, decoding entities', async () => {
    const entries = parseJavaHomeX(await readFile(join(FIXTURES, 'java_home-X.plist'), 'utf8'))
    expect(entries).toEqual([
      { home: '/Users/me/Library/Java/JavaVirtualMachines/openjdk-27/Contents/Home', version: '27', arch: 'arm64', vendor: 'Oracle Corporation', name: 'OpenJDK 27', enabled: true },
      {
        home: '/Library/Java/JavaVirtualMachines/R&D <test>.jdk/Contents/Home',
        version: '17.0.12',
        arch: 'x64',
        vendor: 'Example & Sons',
        name: 'Example "JDK" 17',
        enabled: false,
      },
    ])
  })

  it('rejects malformed plists', () => {
    expect(parseJavaHomeX('Unable to find any JVMs')).toBeUndefined()
    expect(parseJavaHomeX('<plist><array><dict><key>a</key></array></plist>')).toBeUndefined()
    expect(parsePlist('<plist version="1.0"><array/></plist>')).toEqual([])
    expect(parsePlist('<plist><dict><key>n</key><integer>5</integer><key>s</key><string/></dict></plist>')).toEqual({ n: 5, s: '' })
  })
})

describe('listJavaHomes', () => {
  it('uses -X, falls back to -V on stderr, and treats "no JVMs" and a missing tool as empty', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const plist = await readFile(join(FIXTURES, 'java_home-X.plist'), 'utf8')
      const v = await readFile(join(FIXTURES, 'java_home-V.txt'), 'utf8')
      const good = join(dir, 'good')
      await put(join(dir, 'x.plist'), plist)
      await put(join(dir, 'v.txt'), v)
      await put(good, `#!/bin/sh\nif [ "$1" = "-X" ]; then cat '${join(dir, 'x.plist')}'; fi\n`, 0o755)
      expect(await listJavaHomes({ command: good })).toHaveLength(2)

      const legacy = join(dir, 'legacy')
      await put(legacy, `#!/bin/sh\nif [ "$1" = "-X" ]; then echo 'garbage'; exit 0; fi\ncat '${join(dir, 'v.txt')}' >&2\n`, 0o755)
      expect(await listJavaHomes({ command: legacy })).toHaveLength(9)

      const none = join(dir, 'none')
      await put(none, `#!/bin/sh\necho 'Unable to find any JVMs matching version "(null)".' >&2\nexit 1\n`, 0o755)
      expect(await listJavaHomes({ command: none })).toEqual([])
      expect(await listJavaHomes({ command: join(dir, 'missing') })).toEqual([])
    } finally {
      await cleanup()
    }
  })
})
