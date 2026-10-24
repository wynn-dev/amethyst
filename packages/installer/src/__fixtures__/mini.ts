import { buildZip, bytes, sha1, type TestServer } from './helpers'

/** A tiny but complete vanilla version, served from a test server. */
export interface MiniVersion {
  id: string
  json: Record<string, unknown>
  manifest: { latest: { release: string; snapshot: string }; versions: Record<string, unknown>[] }
  /** Library paths (relative to `libraries/`) that must be installed on macOS arm64. */
  expectedLibraries: string[]
  /** Library paths that must not be installed (other OS). */
  excludedLibraries: string[]
  /** Asset object hashes. */
  objects: string[]
  assetIndexSha1: string
}

/**
 * Publish a version `id` on `server`: client jar, five libraries with every rule shape, a log
 * config, an asset index and its objects, the version JSON and a manifest v2 at `/manifest.json`.
 */
export async function publishMiniVersion(server: TestServer, id = 'mini-1', options: { objectDelayMs?: number; objectCount?: number; mappings?: boolean } = {}): Promise<MiniVersion> {
  const base = server.url
  const client = await buildZip({ 'net/minecraft/client/Main.class': 'main', 'pack.png': bytes(2000, 7) })
  server.file(`/data/${id}/client.jar`, client)
  const lib = async (path: string, seed: number) => {
    const data = await buildZip({ [`lib${seed}.class`]: bytes(500 + seed, seed) })
    server.file(`/libs/${path}`, data)
    return { path, sha1: sha1(data), size: data.length, url: `${base}/libs/${path}` }
  }
  const plain = await lib('org/example/plain/1.0/plain-1.0.jar', 1)
  const notMac = await lib('org/example/winonly/1.0/winonly-1.0.jar', 2)
  const arm = await lib('org/example/nat/1.0/nat-1.0-natives-macos-arm64.jar', 3)
  const x86 = await lib('org/example/nat/1.0/nat-1.0-natives-macos.jar', 4)
  const old = await lib('org/example/oldnat/1.0/oldnat-1.0-natives-osx.jar', 5)
  const linux = await lib('org/example/oldnat/1.0/oldnat-1.0-natives-linux.jar', 6)

  const logConfig = Buffer.from('<Configuration/>')
  server.file(`/data/${id}/client.xml`, logConfig)

  const objectCount = options.objectCount ?? 3
  const objects: Record<string, { hash: string; size: number }> = {}
  const hashes: string[] = []
  for (let i = 0; i < objectCount; i++) {
    const data = bytes(300 + i, 100 + i)
    const hash = sha1(data)
    hashes.push(hash)
    objects[`minecraft/sounds/${i}.ogg`] = { hash, size: data.length }
    server.file(`/assets/${hash.slice(0, 2)}/${hash}`, data, { delayMs: options.objectDelayMs })
  }
  // The same object under two names is downloaded once.
  objects['minecraft/duplicate.ogg'] = objects['minecraft/sounds/0.ogg'] as { hash: string; size: number }
  const index = Buffer.from(JSON.stringify({ objects }))
  const indexSha1 = sha1(index)
  server.file(`/data/${id}/index.json`, index)

  const mappings = Buffer.from('net.minecraft.Client -> a:\n')
  server.file(`/data/${id}/client.txt`, mappings)
  const extraDownloads = options.mappings ? { client_mappings: { url: `${base}/data/${id}/client.txt`, sha1: sha1(mappings), size: mappings.length } } : {}
  const json = {
    id,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: `${id}-assets`,
    assetIndex: { id: `${id}-assets`, sha1: indexSha1, size: index.length, totalSize: 999, url: `${base}/data/${id}/index.json` },
    downloads: { client: { url: `${base}/data/${id}/client.jar`, sha1: sha1(client), size: client.length }, ...extraDownloads },
    javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
    logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client-1.xml', sha1: sha1(logConfig), size: logConfig.length, url: `${base}/data/${id}/client.xml` }, type: 'log4j2-xml' } },
    arguments: { game: ['--version', '${version_name}'], jvm: ['-cp', '${classpath}'] },
    libraries: [
      { name: 'org.example:plain:1.0', downloads: { artifact: plain } },
      { name: 'org.example:winonly:1.0', downloads: { artifact: notMac }, rules: [{ action: 'allow', os: { name: 'windows' } }] },
      { name: 'org.example:nat:1.0:natives-macos-arm64', downloads: { artifact: arm }, rules: [{ action: 'allow', os: { name: 'osx' } }] },
      { name: 'org.example:nat:1.0:natives-macos', downloads: { artifact: x86 }, rules: [{ action: 'allow', os: { name: 'osx' } }] },
      {
        name: 'org.example:oldnat:1.0',
        natives: { osx: 'natives-osx', linux: 'natives-linux' },
        downloads: { classifiers: { 'natives-osx': old, 'natives-linux': linux } },
        extract: { exclude: ['META-INF/'] },
      },
    ],
  }
  const text = Buffer.from(JSON.stringify(json))
  server.file(`/data/${id}/${id}.json`, text)
  const manifest = {
    latest: { release: id, snapshot: id },
    versions: [{ id, type: 'release', url: `${base}/data/${id}/${id}.json`, time: '2026-01-01T00:00:00+00:00', releaseTime: '2026-01-01T00:00:00+00:00', sha1: sha1(text), complianceLevel: 1 }],
  }
  server.file('/manifest.json', manifest)
  return {
    id,
    json,
    manifest,
    expectedLibraries: [plain.path, arm.path, x86.path, old.path],
    excludedLibraries: [notMac.path, linux.path],
    objects: hashes,
    assetIndexSha1: indexSha1,
  }
}
