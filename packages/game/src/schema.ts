/**
 * The version JSON model (`versions/<id>/<id>.json`) and its validation.
 *
 * Covers Mojang's modern (`arguments`, 1.13+) and legacy (`minecraftArguments`) forms, plus the
 * third-party shapes produced by Forge, NeoForge, Fabric and Quilt (maven-only libraries with
 * `url`/`checksums`/`sha1`/`size`). Unknown fields are ignored; fields that are used are checked.
 * See https://minecraft.wiki/w/Client.json.
 */
import { GameError } from './errors'

/** `os` block of a rule. `versionRange` appears in 26.x JSON (`min` inclusive, `max` exclusive). */
export interface RuleOs {
  name?: string
  /** Regex matched against the OS product version (macOS: `sw_vers -productVersion`). */
  version?: string
  arch?: string
  versionRange?: { min?: string; max?: string }
}

export interface Rule {
  action: 'allow' | 'disallow'
  os?: RuleOs
  features?: Record<string, boolean>
}

/** A JVM or game argument: a literal, or a rule-gated value (string or list, spliced in). */
export type Argument = string | { rules?: Rule[]; value: string | string[] }

export interface Artifact {
  path?: string
  url?: string
  sha1?: string
  size?: number
}

export interface LibraryJson {
  /** Maven coordinate `group:artifact:version[:classifier][@ext]`. */
  name: string
  downloads?: { artifact?: Artifact; classifiers?: Record<string, Artifact> }
  /** Old-style natives: OS name → classifier (may contain `${arch}`). */
  natives?: Record<string, string>
  extract?: { exclude?: string[] }
  rules?: Rule[]
  /** Maven repository base URL (legacy Forge, Fabric, Quilt). */
  url?: string
  /** Legacy Forge: any listed sha1 is acceptable. */
  checksums?: string[]
  /** Fabric/Quilt meta. */
  sha1?: string
  sha256?: string
  size?: number
}

export interface AssetIndexRef {
  id: string
  sha1?: string
  size?: number
  totalSize?: number
  url?: string
}

export interface DownloadEntry {
  sha1?: string
  size?: number
  url?: string
  path?: string
}

export interface LoggingClient {
  /** For example `-Dlog4j.configurationFile=${path}`. */
  argument: string
  file: { id: string; sha1?: string; size?: number; url?: string }
  type?: string
}

export interface JavaVersionRef {
  component?: string
  majorVersion: number
}

export interface VersionJson {
  id: string
  inheritsFrom?: string
  type?: string
  time?: string
  releaseTime?: string
  mainClass?: string
  minecraftArguments?: string
  arguments?: { game?: Argument[]; jvm?: Argument[]; 'default-user-jvm'?: Argument[] }
  libraries?: LibraryJson[]
  assets?: string
  assetIndex?: AssetIndexRef
  downloads?: Record<string, DownloadEntry>
  javaVersion?: JavaVersionRef
  /** `{}` is meaningful: modern Forge uses it to switch off the vanilla log4j config. */
  logging?: { client?: LoggingClient }
  minimumLauncherVersion?: number
  complianceLevel?: number
  /** Third-party: ignored for the classpath (see launch.md §6). */
  jar?: string
  /** Third-party conventions naming the underlying Minecraft version. */
  clientVersion?: string
  _minecraftVersion?: string
  /** Pack-supplied allow-list of Java majors (java.md). */
  compatibleJavaMajors?: number[]
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

class Checker {
  constructor(readonly version: string) {}

  fail(where: string, what: string): never {
    throw new GameError('EVERSION_INVALID', `Version ${this.version}: ${where} ${what}`, { version: this.version, field: where })
  }

  str(o: Obj, key: string, where: string): string | undefined {
    const v = o[key]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string') this.fail(`${where}.${key}`, 'must be a string')
    return v
  }

  num(o: Obj, key: string, where: string): number | undefined {
    const v = o[key]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'number' || !Number.isFinite(v)) this.fail(`${where}.${key}`, 'must be a number')
    return v
  }

  artifact(v: unknown, where: string): Artifact | undefined {
    if (v === undefined || v === null) return undefined
    if (!isObj(v)) this.fail(where, 'must be an object')
    return { path: this.str(v, 'path', where), url: this.str(v, 'url', where), sha1: this.str(v, 'sha1', where), size: this.num(v, 'size', where) }
  }

  rules(v: unknown, where: string): Rule[] | undefined {
    if (v === undefined || v === null) return undefined
    if (!Array.isArray(v)) this.fail(where, 'must be an array')
    return v.map((r, i) => {
      const w = `${where}[${i}]`
      if (!isObj(r)) this.fail(w, 'must be an object')
      if (r.action !== 'allow' && r.action !== 'disallow') this.fail(`${w}.action`, 'must be "allow" or "disallow"')
      const rule: Rule = { action: r.action }
      if (r.os !== undefined) {
        if (!isObj(r.os)) this.fail(`${w}.os`, 'must be an object')
        const os: RuleOs = { name: this.str(r.os, 'name', `${w}.os`), version: this.str(r.os, 'version', `${w}.os`), arch: this.str(r.os, 'arch', `${w}.os`) }
        const range = r.os.versionRange
        if (range !== undefined) {
          if (!isObj(range)) this.fail(`${w}.os.versionRange`, 'must be an object')
          os.versionRange = { min: this.str(range, 'min', `${w}.os.versionRange`), max: this.str(range, 'max', `${w}.os.versionRange`) }
        }
        rule.os = os
      }
      if (r.features !== undefined) {
        if (!isObj(r.features)) this.fail(`${w}.features`, 'must be an object')
        const features: Record<string, boolean> = {}
        for (const [k, fv] of Object.entries(r.features)) {
          if (typeof fv !== 'boolean') this.fail(`${w}.features.${k}`, 'must be a boolean')
          features[k] = fv
        }
        rule.features = features
      }
      return rule
    })
  }

  args(v: unknown, where: string): Argument[] | undefined {
    if (v === undefined || v === null) return undefined
    if (!Array.isArray(v)) this.fail(where, 'must be an array')
    return v.map((a, i): Argument => {
      const w = `${where}[${i}]`
      if (typeof a === 'string') return a
      if (!isObj(a)) this.fail(w, 'must be a string or an object')
      const value = a.value
      if (typeof value !== 'string' && !(Array.isArray(value) && value.every((x) => typeof x === 'string'))) {
        this.fail(`${w}.value`, 'must be a string or a list of strings')
      }
      return { rules: this.rules(a.rules, `${w}.rules`), value: value as string | string[] }
    })
  }

  library(v: unknown, where: string): LibraryJson {
    if (!isObj(v)) this.fail(where, 'must be an object')
    const name = this.str(v, 'name', where)
    if (!name) this.fail(`${where}.name`, 'is required')
    const lib: LibraryJson = { name }
    if (v.downloads !== undefined) {
      if (!isObj(v.downloads)) this.fail(`${where}.downloads`, 'must be an object')
      const downloads: NonNullable<LibraryJson['downloads']> = {}
      const artifact = this.artifact(v.downloads.artifact, `${where}.downloads.artifact`)
      if (artifact) downloads.artifact = artifact
      if (v.downloads.classifiers !== undefined) {
        if (!isObj(v.downloads.classifiers)) this.fail(`${where}.downloads.classifiers`, 'must be an object')
        downloads.classifiers = {}
        for (const [k, a] of Object.entries(v.downloads.classifiers)) {
          const art = this.artifact(a, `${where}.downloads.classifiers.${k}`)
          if (art) downloads.classifiers[k] = art
        }
      }
      lib.downloads = downloads
    }
    if (v.natives !== undefined) {
      if (!isObj(v.natives)) this.fail(`${where}.natives`, 'must be an object')
      const natives: Record<string, string> = {}
      for (const [k, c] of Object.entries(v.natives)) {
        if (typeof c !== 'string') this.fail(`${where}.natives.${k}`, 'must be a string')
        natives[k] = c
      }
      lib.natives = natives
    }
    if (v.extract !== undefined) {
      if (!isObj(v.extract)) this.fail(`${where}.extract`, 'must be an object')
      const exclude = v.extract.exclude
      if (exclude !== undefined && !(Array.isArray(exclude) && exclude.every((x) => typeof x === 'string'))) {
        this.fail(`${where}.extract.exclude`, 'must be a list of strings')
      }
      lib.extract = { exclude: exclude as string[] | undefined }
    }
    const rules = this.rules(v.rules, `${where}.rules`)
    if (rules) lib.rules = rules
    const url = this.str(v, 'url', where)
    if (url !== undefined) lib.url = url
    if (v.checksums !== undefined) {
      if (!(Array.isArray(v.checksums) && v.checksums.every((x) => typeof x === 'string'))) this.fail(`${where}.checksums`, 'must be a list of strings')
      lib.checksums = v.checksums as string[]
    }
    const sha1 = this.str(v, 'sha1', where)
    if (sha1 !== undefined) lib.sha1 = sha1
    const sha256 = this.str(v, 'sha256', where)
    if (sha256 !== undefined) lib.sha256 = sha256
    const size = this.num(v, 'size', where)
    if (size !== undefined) lib.size = size
    return lib
  }
}

/**
 * Validate an already-parsed version JSON. `expectedId` is the folder name, which is
 * authoritative; a missing `id` field defaults to it.
 *
 * @throws {GameError} `EVERSION_INVALID` naming the offending field.
 */
export function validateVersionJson(raw: unknown, expectedId: string): VersionJson {
  const c: Checker = new Checker(expectedId)
  if (!isObj(raw)) c.fail('root', 'must be an object')
  const out: VersionJson = { id: c.str(raw, 'id', 'root') ?? expectedId }
  for (const key of ['inheritsFrom', 'type', 'time', 'releaseTime', 'mainClass', 'minecraftArguments', 'assets', 'jar', 'clientVersion', '_minecraftVersion'] as const) {
    const v = c.str(raw, key, 'root')
    if (v !== undefined) out[key] = v
  }
  for (const key of ['minimumLauncherVersion', 'complianceLevel'] as const) {
    const v = c.num(raw, key, 'root')
    if (v !== undefined) out[key] = v
  }
  if (raw.arguments !== undefined && raw.arguments !== null) {
    if (!isObj(raw.arguments)) c.fail('arguments', 'must be an object')
    const args: NonNullable<VersionJson['arguments']> = {}
    const game = c.args(raw.arguments.game, 'arguments.game')
    if (game) args.game = game
    const jvm = c.args(raw.arguments.jvm, 'arguments.jvm')
    if (jvm) args.jvm = jvm
    const def = c.args(raw.arguments['default-user-jvm'], 'arguments.default-user-jvm')
    if (def) args['default-user-jvm'] = def
    out.arguments = args
  }
  if (raw.libraries !== undefined && raw.libraries !== null) {
    if (!Array.isArray(raw.libraries)) c.fail('libraries', 'must be an array')
    out.libraries = raw.libraries.map((l, i) => c.library(l, `libraries[${i}]`))
  }
  if (raw.assetIndex !== undefined && raw.assetIndex !== null) {
    const a = raw.assetIndex
    if (!isObj(a)) c.fail('assetIndex', 'must be an object')
    const id = c.str(a, 'id', 'assetIndex')
    if (!id) c.fail('assetIndex.id', 'is required')
    out.assetIndex = { id, sha1: c.str(a, 'sha1', 'assetIndex'), size: c.num(a, 'size', 'assetIndex'), totalSize: c.num(a, 'totalSize', 'assetIndex'), url: c.str(a, 'url', 'assetIndex') }
  }
  if (raw.downloads !== undefined && raw.downloads !== null) {
    if (!isObj(raw.downloads)) c.fail('downloads', 'must be an object')
    const downloads: Record<string, DownloadEntry> = {}
    for (const [k, d] of Object.entries(raw.downloads)) {
      const art = c.artifact(d, `downloads.${k}`)
      if (art) downloads[k] = art
    }
    out.downloads = downloads
  }
  if (raw.javaVersion !== undefined && raw.javaVersion !== null) {
    const j = raw.javaVersion
    if (!isObj(j)) c.fail('javaVersion', 'must be an object')
    const majorVersion = c.num(j, 'majorVersion', 'javaVersion')
    if (majorVersion === undefined) c.fail('javaVersion.majorVersion', 'is required')
    out.javaVersion = { component: c.str(j, 'component', 'javaVersion'), majorVersion }
  }
  if (raw.logging !== undefined && raw.logging !== null) {
    if (!isObj(raw.logging)) c.fail('logging', 'must be an object')
    out.logging = {}
    const client = raw.logging.client
    if (client !== undefined && client !== null) {
      if (!isObj(client)) c.fail('logging.client', 'must be an object')
      const argument = c.str(client, 'argument', 'logging.client')
      if (!argument) c.fail('logging.client.argument', 'is required')
      if (!isObj(client.file)) c.fail('logging.client.file', 'must be an object')
      const id = c.str(client.file, 'id', 'logging.client.file')
      if (!id) c.fail('logging.client.file.id', 'is required')
      out.logging.client = {
        argument,
        file: { id, sha1: c.str(client.file, 'sha1', 'logging.client.file'), size: c.num(client.file, 'size', 'logging.client.file'), url: c.str(client.file, 'url', 'logging.client.file') },
        type: c.str(client, 'type', 'logging.client'),
      }
    }
  }
  if (raw.compatibleJavaMajors !== undefined && raw.compatibleJavaMajors !== null) {
    const v = raw.compatibleJavaMajors
    if (!(Array.isArray(v) && v.every((x) => Number.isInteger(x)))) c.fail('compatibleJavaMajors', 'must be a list of integers')
    out.compatibleJavaMajors = v as number[]
  }
  return out
}

/**
 * Parse and validate version JSON text.
 *
 * @throws {GameError} `EVERSION_CORRUPT` for invalid JSON, `EVERSION_INVALID` for a bad shape.
 */
export function parseVersionJson(text: string, expectedId: string): VersionJson {
  let raw: unknown
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (e) {
    throw new GameError('EVERSION_CORRUPT', `Version ${expectedId}: invalid JSON`, { version: expectedId }, { cause: e })
  }
  return validateVersionJson(raw, expectedId)
}
