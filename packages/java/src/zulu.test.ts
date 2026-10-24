import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HttpClient, JsonOptions } from '@amethyst/net'
import { describe, expect, it } from 'vitest'
import { FIXTURES } from './__fixtures__/helpers'
import { chooseZuluPackage, findZuluPackage, parseZuluPackage, parseZuluPackages, zuluListUrl } from './zulu'

const json = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(FIXTURES, name), 'utf8'))

/** A fake client answering `json()` from a URL -> body map. */
function fakeClient(routes: Record<string, unknown>, seen: string[] = []): HttpClient {
  return {
    userAgent: 'test',
    async json<T>(url: string, options?: JsonOptions<T>): Promise<T> {
      seen.push(url)
      const key = Object.keys(routes).find((k) => url.startsWith(k))
      if (!key) throw Object.assign(new Error(`404 ${url}`), { code: 'EHTTP' })
      return options?.parse ? options.parse(routes[key]) : (routes[key] as T)
    },
  } as unknown as HttpClient
}

describe('Azul metadata API', () => {
  it('builds the list query for macOS aarch64 GA JREs without JavaFX', () => {
    const url = new URL(zuluListUrl({ major: 8 }))
    expect(url.origin + url.pathname).toBe('https://api.azul.com/metadata/v1/zulu/packages/')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      java_version: '8',
      os: 'macos',
      arch: 'aarch64',
      archive_type: 'tar.gz',
      java_package_type: 'jre',
      javafx_bundled: 'false',
      release_status: 'ga',
      availability_types: 'CA',
      latest: 'true',
    })
  })

  it('parses the live list and picks the newest of several "latest" items', async () => {
    const list = parseZuluPackages(await json('zulu-packages-8.json'))
    expect(list).toHaveLength(2)
    expect(list.every((p) => p.latest)).toBe(true)
    const choice = chooseZuluPackage(list, 8)
    expect(choice).toMatchObject({ packageUuid: '841e5f64-a746-4803-8b56-4e14767efb1b', javaVersion: [8, 0, 512], name: 'zulu8.98.0.107-ca-jre8.0.512-macosx_aarch64.tar.gz' })
    expect(chooseZuluPackage(list.toReversed(), 8)?.javaVersion).toEqual([8, 0, 512])
    expect(chooseZuluPackage(list, 17)).toBeUndefined()
  })

  it('orders by distro version when java versions tie and skips non-matching archives', () => {
    const base = { latest: true, javaVersion: [21, 0, 7], downloadUrl: 'https://cdn.azul.com/x' }
    const pick = chooseZuluPackage(
      [
        { ...base, packageUuid: 'a', name: 'zulu21.40.1-ca-jre21.0.7-macosx_aarch64.tar.gz', distroVersion: [21, 40, 1] },
        { ...base, packageUuid: 'b', name: 'zulu21.42.19-ca-jre21.0.7-macosx_aarch64.tar.gz', distroVersion: [21, 42, 19] },
        { ...base, packageUuid: 'c', name: 'zulu21.50.0-ca-jre21.0.7-macosx_aarch64.zip', distroVersion: [21, 50, 0] },
        { ...base, packageUuid: 'd', name: 'zulu21.50.0-ca-jre21.0.7-macosx_x64.tar.gz', distroVersion: [21, 50, 0] },
      ],
      21,
    )
    expect(pick?.packageUuid).toBe('b')
  })

  it('parses package details and refuses to proceed without a sha256', async () => {
    const detail = await json('zulu-package-detail-8.json')
    const pkg = parseZuluPackage(detail)
    expect(pkg).toMatchObject({
      sha256: 'e363187e4c49650906b17466d5f158a2a488a0ed8dde296a54399fa45d19e895',
      size: 40166300,
      packageType: 'jre',
      os: 'macos',
      arch: 'arm',
      archiveType: 'tar.gz',
      javafx: false,
      downloadUrl: 'https://cdn.azul.com/zulu/bin/zulu8.98.0.107-ca-jre8.0.512-macosx_aarch64.tar.gz',
    })
    const o = detail as Record<string, unknown>
    expect(() => parseZuluPackage({ ...o, sha256_hash: undefined })).toThrow(/sha256/)
    expect(() => parseZuluPackage({ ...o, sha256_hash: 'abc' })).toThrow(/sha256/)
    expect(() => parseZuluPackage({ ...o, size: 0 })).toThrow(/size/)
    expect(() => parseZuluPackage({ ...o, os: 'linux' })).toThrow(/linux/)
    expect(() => parseZuluPackage({ ...o, arch: 'x86' })).toThrow(/x86/)
    // Download URLs must be HTTPS on azul.com unless the API base is overridden.
    expect(() => parseZuluPackage({ ...o, download_url: 'https://evil.example/zulu.tar.gz' })).toThrow(/malformed/)
    expect(() => parseZuluPackage({ ...o, download_url: 'http://cdn.azul.com/zulu.tar.gz' })).toThrow(/malformed/)
    expect(parseZuluPackage({ ...o, download_url: 'http://127.0.0.1/zulu.tar.gz' }, { allowAnyHost: true }).downloadUrl).toBe('http://127.0.0.1/zulu.tar.gz')
    expect(() => parseZuluPackages({ error: 'nope' })).toThrow(/not an array/)
  })

  it('finds a package via list + detail, falling back to a JDK when no JRE exists', async () => {
    const detail = await json('zulu-package-detail-8.json')
    const list = await json('zulu-packages-8.json')
    const seen: string[] = []
    const client = fakeClient(
      {
        'https://api.azul.com/metadata/v1/zulu/packages/?java_version=8&os=macos&arch=aarch64&archive_type=tar.gz&java_package_type=jre': [],
        'https://api.azul.com/metadata/v1/zulu/packages/?java_version=8&os=macos&arch=aarch64&archive_type=tar.gz&java_package_type=jdk': list,
        'https://api.azul.com/metadata/v1/zulu/packages/841e5f64-a746-4803-8b56-4e14767efb1b': detail,
      },
      seen,
    )
    const pkg = await findZuluPackage(8, { client })
    expect(pkg.sha256).toMatch(/^e363187e/)
    expect(seen).toHaveLength(3)
    await expect(findZuluPackage(8, { client, allowJdk: false })).rejects.toMatchObject({ code: 'ENORUNTIME' })
  })
})
