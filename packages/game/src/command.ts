/**
 * Building the game command line (launch.md §6, §7, §9, §11): template variables, classpath,
 * JVM options, log4j configuration, features, quick play and environment.
 *
 * The result is an argv array for `spawn` (never a shell string). Use {@link redactCommand} to
 * log it.
 */
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { toArgv } from './argv'
import { assetIndexCandidates, assetObjectPath, readAssetIndex } from './assets'
import { GameError } from './errors'
import { nativesDirectory } from './natives/extract'
import type { Lwjgl2Arm64Source } from './natives/lwjgl2'
import { planNatives, type NativesPlan } from './natives/plan'
import type { ResolvedVersion } from './resolve'
import { evaluateRules, hasFeatureRules, requireArch, type Features, type JvmArch, type Platform } from './rules'
import type { Argument } from './schema'

/** Shared resource directories. Only `root` is required; the others default to `<root>/<name>`. */
export interface GameDirs {
  root: string
  versions?: string
  libraries?: string
  assets?: string
}

export interface ResolvedDirs {
  root: string
  versions: string
  libraries: string
  assets: string
}

export function resolveDirs(dirs: GameDirs | string): ResolvedDirs {
  const d = typeof dirs === 'string' ? { root: dirs } : dirs
  return {
    root: d.root,
    versions: d.versions ?? path.join(d.root, 'versions'),
    libraries: d.libraries ?? path.join(d.root, 'libraries'),
    assets: d.assets ?? path.join(d.root, 'assets'),
  }
}

export interface LaunchAuth {
  username: string
  /** Profile id, with or without dashes. */
  uuid: string
  /** Minecraft access token. Omitted for offline accounts (a random token is used). */
  accessToken?: string
  /** `msa` for Microsoft accounts, `legacy` for offline ones. Default `msa`. */
  userType?: 'msa' | 'legacy'
  /** Xbox user id (`${auth_xuid}`). */
  xuid?: string
  /** Launcher client id (`${clientid}`). */
  clientId?: string
}

export type QuickPlay = { type: 'multiplayer'; host: string; port?: number } | { type: 'singleplayer'; world: string } | { type: 'realms'; realm: string }

export interface BuildLaunchOptions {
  /** The selected JVM. `arch` must come from probing that JVM. */
  java: { path: string; arch: JvmArch | string }
  dirs: GameDirs | string
  /** Instance game directory: the cwd and `${game_directory}`. */
  gameDir: string
  auth: LaunchAuth
  /** Precomputed plan; otherwise {@link planNatives} runs with the options below. */
  natives?: NativesPlan
  lwjgl2?: Lwjgl2Arm64Source
  replaceNatives?: boolean
  /** macOS product version for rules. Default `13.0`. */
  osVersion?: string
  /** Natives directory; default {@link nativesDirectory}. */
  nativesDir?: string
  /** Build the command even when the plan reports unavailable natives. Default false. */
  allowUnavailableNatives?: boolean
  demo?: boolean
  /** `${launcher_name}` (default `amethyst`). */
  launcherName?: string
  /** `${launcher_version}` (the app version). */
  launcherVersion?: string
  /** Heap sizes in MiB; 0/undefined means "do not pass". `minMB` is clamped to `maxMB`. */
  memory?: { minMB?: number; maxMB?: number }
  /**
   * Extra JVM arguments (a list of tokens or a string parsed with shell-style quoting). When
   * undefined, the version's `default-user-jvm` arguments are used if it declares any.
   */
  jvmArgs?: string | readonly string[]
  gameArgs?: string | readonly string[]
  /** Wrapper command put before java, for example `caffeinate -i`. */
  wrapper?: string | readonly string[]
  resolution?: { width?: number; height?: number; fullscreen?: boolean }
  quickPlay?: QuickPlay
  /** `${quickPlayPath}`: where the game writes its quick-play log. Enables `has_quick_plays_support`. */
  quickPlayPath?: string
  /** Environment overrides (global + instance, already merged). They win over the base env. */
  env?: Record<string, string>
  /** Base environment; defaults to `process.env`. It is sanitised. */
  baseEnv?: Record<string, string | undefined>
  /** Overrides for `${version_name}` (game side) and `${version_type}`. */
  versionName?: string
  versionType?: string
  /** `-Xdock:name` (default `Minecraft`). */
  dockName?: string
  /** `-Xdock:icon` path, or `false` for none. Default: `icons/minecraft.icns` from the asset index. */
  dockIcon?: string | false
  extraClasspath?: readonly string[]
  /** Fail with `ELOG_CONFIG_MISSING` when the declared log4j config is not on disk. Default true. */
  requireLogConfig?: boolean
}

export interface LaunchCommand {
  /** The java executable. */
  java: string
  /** Arguments for java (not including `java` itself). */
  args: string[]
  /** Words to run before java, e.g. `['caffeinate', '-i']`. Spawn `[...wrapper, java, ...args]`. */
  wrapper: string[]
  cwd: string
  env: Record<string, string>
  /** Values to redact when printing the command. */
  secrets: string[]
  warnings: string[]
  natives: NativesPlan
  nativesDir: string
  classpath: string[]
  features: Features
}

/** Every variable Amethyst knows. A known variable is never passed through literally. */
export const KNOWN_VARIABLES = [
  'natives_directory',
  'launcher_name',
  'launcher_version',
  'classpath',
  'classpath_separator',
  'library_directory',
  'version_name',
  'game_directory',
  'assets_root',
  'game_assets',
  'assets_index_name',
  'auth_player_name',
  'auth_uuid',
  'auth_access_token',
  'auth_session',
  'user_type',
  'user_properties',
  'version_type',
  'resolution_width',
  'resolution_height',
  'clientid',
  'auth_xuid',
  'quickPlayPath',
  'quickPlaySingleplayer',
  'quickPlayMultiplayer',
  'quickPlayRealms',
  'path',
] as const

export type TemplateVariables = Partial<Record<(typeof KNOWN_VARIABLES)[number], string>> & Record<string, string | undefined>

const KNOWN = new Set<string>(KNOWN_VARIABLES)
/** Variables that are expected to be empty sometimes; dropping them (with their flag) is silent. */
const OPTIONAL = new Set(['clientid', 'auth_xuid', 'quickPlayPath', 'quickPlaySingleplayer', 'quickPlayMultiplayer', 'quickPlayRealms'])
const PLACEHOLDER = /\$\{([^}]+)\}/g
const ONLY_PLACEHOLDER = /^\$\{([^}]+)\}$/

/** Replace `${name}` placeholders in one string. Unknown variables stay literal; known empty ones become `''`. */
export function substitute(arg: string, vars: TemplateVariables, warnings?: string[]): string {
  return arg.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name]
    if (value !== undefined && value !== '') return value
    if (KNOWN.has(name)) {
      if (!OPTIONAL.has(name)) warnings?.push(`Variable \${${name}} is empty in ${JSON.stringify(arg)}`)
      return ''
    }
    warnings?.push(`Unknown variable \${${name}} left as is in ${JSON.stringify(arg)}`)
    return whole
  })
}

/**
 * Evaluate rule-gated entries and template every string. An argument that is only a known,
 * empty placeholder is dropped, together with the preceding `--flag` if there is one
 * (`--clientId ${clientid}` disappears when no client id is set).
 */
export function expandArguments(args: readonly Argument[], platform: Platform, features: Features, vars: TemplateVariables, warnings?: string[]): string[] {
  const out: string[] = []
  for (const entry of args) {
    let values: readonly string[]
    if (typeof entry === 'string') values = [entry]
    else if (evaluateRules(entry.rules, platform, features)) values = typeof entry.value === 'string' ? [entry.value] : entry.value
    else continue
    for (const raw of values) {
      const only = ONLY_PLACEHOLDER.exec(raw)
      if (only && KNOWN.has(only[1] as string) && !vars[only[1] as string]) {
        const name = only[1] as string
        if (out.length > 0 && (out.at(-1) as string).startsWith('--')) out.pop()
        if (!OPTIONAL.has(name)) warnings?.push(`Dropped argument \${${name}}: no value`)
        continue
      }
      out.push(substitute(raw, vars, warnings))
    }
  }
  return out
}

/** True when some argument entry is gated on `feature`. */
export function declaresFeature(args: readonly Argument[], feature: string): boolean {
  return args.some((a) => typeof a !== 'string' && hasFeatureRules(a.rules) && !!a.rules?.some((r) => r.features && feature in r.features))
}

/** Parse `1.x[.y]` and year-based `26.x[.y]` release ids. Returns undefined for snapshots and others. */
export function parseRelease(id: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(id)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined
}

function cmp(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  return 0
}

/**
 * Whether a version is in the Log4Shell-affected range 1.7–1.18.0. Snapshots and other ids are
 * judged by release time (Mojang's fix shipped on 2021-12-10).
 */
export function isLog4ShellAffected(version: Pick<ResolvedVersion, 'minecraftVersion' | 'releaseTime'>): boolean {
  const r = parseRelease(version.minecraftVersion)
  if (r) return cmp(r, [1, 7, 0]) >= 0 && cmp(r, [1, 18, 0]) <= 0
  const t = version.releaseTime ? Date.parse(version.releaseTime) : Number.NaN
  return Number.isFinite(t) && t >= Date.parse('2013-09-01T00:00:00Z') && t < Date.parse('2021-12-10T00:00:00Z')
}

const STRIPPED_ENV = [/^ELECTRON_/, /^NODE_OPTIONS$/, /^DYLD_/, /^JAVA_TOOL_OPTIONS$/, /^_JAVA_OPTIONS$/, /^JDK_JAVA_OPTIONS$/]

/**
 * The child environment: `base` without Electron/Node/dyld/JVM-injection variables, then
 * `overrides` on top. Explicit `JAVA_*`/`_JAVA_*`/`JDK_*` overrides are kept and reported.
 */
export function sanitizeEnv(base: Record<string, string | undefined>, overrides: Record<string, string> = {}, warnings?: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || STRIPPED_ENV.some((re) => re.test(k))) continue
    env[k] = v
  }
  for (const [k, v] of Object.entries(overrides)) {
    env[k] = v
    if (/^(JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)$/.test(k)) warnings?.push(`Environment sets ${k}=${v}`)
  }
  return env
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isFile(),
    () => false,
  )
}

function positiveInt(v: number | undefined, what: string): number | undefined {
  if (v === undefined || v === 0) return undefined
  if (!Number.isInteger(v) || v < 0) throw new GameError('ELAUNCH_OPTIONS', `${what} must be a non-negative integer`, { field: what })
  return v
}

const hasPrefix = (args: readonly string[], prefix: string) => args.some((a) => a.startsWith(prefix))

/**
 * Build the full command for `version`.
 *
 * Argument order: dock name/icon, `-Xms`/`-Xmx`, the version's JVM arguments (plus the log4j
 * config, the Log4Shell fallback, and any of `-XstartOnFirstThread`, `java.library.path` and
 * the launcher brand that are missing), `-DlibraryDirectory`, user JVM arguments, main class,
 * the version's game arguments, user game arguments, then manual `--server`/`--port`,
 * resolution and `--demo` for versions whose JSON lacks the feature-gated forms.
 *
 * @throws {GameError} `ENATIVES_UNAVAILABLE`, `ELIBRARY_PATH`, `ELOG_CONFIG_MISSING`, `ELAUNCH_OPTIONS`.
 */
export async function buildLaunchCommand(version: ResolvedVersion, options: BuildLaunchOptions): Promise<LaunchCommand> {
  const dirs = resolveDirs(options.dirs)
  const warnings: string[] = []
  const jvmArch = requireArch(options.java.arch)
  const plan =
    options.natives ?? planNatives(version, { jvmArch, osVersion: options.osVersion, lwjgl2: options.lwjgl2, replace: options.replaceNatives })
  if (plan.jvmArch !== jvmArch) throw new GameError('ELAUNCH_OPTIONS', `Natives plan is for ${plan.jvmArch} but the JVM is ${jvmArch}`, { field: 'natives' })
  warnings.push(...plan.warnings)
  if (!plan.ok && !options.allowUnavailableNatives) {
    throw new GameError('ENATIVES_UNAVAILABLE', plan.issues.map((i) => i.message).join('; '), { issues: plan.issues, version: version.id })
  }
  const platform = plan.platform
  const nativesDir = options.nativesDir ?? nativesDirectory(dirs.versions, version.id, plan)
  const gameDir = path.resolve(options.gameDir)

  // Classpath: libraries in merged order, then the root's client jar, then extras.
  const classpath: string[] = []
  const seen = new Set<string>()
  for (const lib of plan.classpath) {
    if (!lib.download.path) throw new GameError('ELIBRARY_PATH', `Library ${lib.name} has no path`, { library: lib.name })
    const p = path.join(dirs.libraries, lib.download.path)
    if (!seen.has(p)) classpath.push(p)
    seen.add(p)
  }
  const mc = version.minecraftVersion
  classpath.push(path.join(dirs.versions, mc, `${mc}.jar`))
  for (const p of options.extraClasspath ?? []) if (!seen.has(p)) classpath.push(p)

  // Assets.
  let assetsIndexName = version.assets
  const candidates = assetIndexCandidates(dirs.assets, version)
  if (!(await exists(candidates[0] as string)) && candidates[1] && (await exists(candidates[1]))) assetsIndexName = version.assetIndex?.sha1 ?? assetsIndexName

  // Auth.
  const auth = options.auth
  const uuid = auth.uuid.replaceAll('-', '')
  const userType = auth.userType ?? 'msa'
  const accessToken = auth.accessToken || randomBytes(16).toString('hex')
  const online = userType === 'msa' && !!auth.accessToken
  const session = online ? `token:${accessToken}:${uuid}` : accessToken

  // Features.
  const gameArgsJson = version.arguments.game
  const features: Features = {}
  const res = options.resolution
  const customResolution = !!res && !res.fullscreen && !!res.width && !!res.height
  if (customResolution) features.has_custom_resolution = true
  if (options.demo) features.is_demo_user = true
  const qp = options.quickPlay
  const quickPlayFeature = qp && (qp.type === 'multiplayer' ? 'is_quick_play_multiplayer' : qp.type === 'singleplayer' ? 'is_quick_play_singleplayer' : 'is_quick_play_realms')
  const supportsQuickPlay = !!quickPlayFeature && declaresFeature(gameArgsJson, quickPlayFeature)
  if (qp && supportsQuickPlay && quickPlayFeature) {
    features[quickPlayFeature] = true
    if (options.quickPlayPath) features.has_quick_plays_support = true
  }

  const vars: TemplateVariables = {
    natives_directory: nativesDir,
    launcher_name: options.launcherName ?? 'amethyst',
    launcher_version: options.launcherVersion ?? '0',
    classpath: classpath.join(':'),
    classpath_separator: ':',
    library_directory: dirs.libraries,
    version_name: options.versionName ?? version.id,
    game_directory: gameDir,
    assets_root: dirs.assets,
    game_assets: path.join(dirs.assets, 'virtual', version.assets),
    assets_index_name: assetsIndexName,
    auth_player_name: auth.username,
    auth_uuid: uuid,
    auth_access_token: accessToken,
    auth_session: session,
    user_type: userType,
    user_properties: '{}',
    version_type: options.versionType ?? version.type,
    resolution_width: customResolution ? String(res?.width) : '-1',
    resolution_height: customResolution ? String(res?.height) : '-1',
    clientid: auth.clientId,
    auth_xuid: auth.xuid,
    quickPlayPath: options.quickPlayPath,
    quickPlaySingleplayer: qp?.type === 'singleplayer' ? qp.world : undefined,
    quickPlayMultiplayer: qp?.type === 'multiplayer' ? `${qp.host}:${qp.port ?? 25565}` : undefined,
    quickPlayRealms: qp?.type === 'realms' ? qp.realm : undefined,
  }
  // The JVM side's ${version_name} is the jar basename (Forge's -DignoreList relies on it).
  const jvmVars: TemplateVariables = { ...vars, version_name: mc }

  const args: string[] = []

  // macOS dock.
  args.push(`-Xdock:name=${options.dockName ?? 'Minecraft'}`)
  let icon = options.dockIcon
  if (icon === undefined) {
    icon = false
    try {
      const { index } = await readAssetIndex(dirs.assets, version)
      const obj = index.objects['icons/minecraft.icns'] ?? index.objects['minecraft/icons/minecraft.icns']
      if (obj && (await exists(assetObjectPath(dirs.assets, obj.hash)))) icon = assetObjectPath(dirs.assets, obj.hash)
    } catch {
      // No index yet: no icon.
    }
  }
  if (icon) args.push(`-Xdock:icon=${icon}`)

  // Memory.
  let minMB = positiveInt(options.memory?.minMB, 'memory.minMB')
  const maxMB = positiveInt(options.memory?.maxMB, 'memory.maxMB')
  if (minMB !== undefined && maxMB !== undefined && minMB > maxMB) {
    warnings.push(`-Xms ${minMB}M is larger than -Xmx ${maxMB}M; using ${maxMB}M for both`)
    minMB = maxMB
  }
  if (minMB !== undefined) args.push(`-Xms${minMB}M`)
  if (maxMB !== undefined) args.push(`-Xmx${maxMB}M`)

  // Version JVM arguments.
  const jvm = expandArguments(version.arguments.jvm, platform, features, jvmVars, warnings)
  if (plan.lwjgl === 3 && !jvm.includes('-XstartOnFirstThread')) jvm.unshift('-XstartOnFirstThread')
  if (plan.lwjgl === 2 && jvm.includes('-XstartOnFirstThread')) {
    warnings.push('Removed -XstartOnFirstThread: LWJGL 2 deadlocks with it')
    jvm.splice(jvm.indexOf('-XstartOnFirstThread'), 1)
  }
  if (!hasPrefix(jvm, '-Djava.library.path=')) jvm.push(`-Djava.library.path=${nativesDir}`)
  if (!hasPrefix(jvm, '-Dminecraft.launcher.brand=')) jvm.push(`-Dminecraft.launcher.brand=${vars.launcher_name}`)
  if (!hasPrefix(jvm, '-Dminecraft.launcher.version=')) jvm.push(`-Dminecraft.launcher.version=${vars.launcher_version}`)
  if (!jvm.includes('-cp') && !jvm.includes('-classpath')) jvm.push('-cp', vars.classpath as string)
  args.push(...jvm)

  // log4j configuration (§9).
  const client = version.logging?.client
  if (client) {
    const id = client.file.id
    const file = path.join(dirs.assets, 'log_configs', path.basename(id))
    if (await exists(file)) {
      args.push(substitute(client.argument, { ...jvmVars, path: file }, warnings))
    } else if (options.requireLogConfig === false) {
      warnings.push(`log4j config ${id} is missing; launching without it`)
      if (isLog4ShellAffected(version)) args.push('-Dlog4j2.formatMsgNoLookups=true')
    } else {
      throw new GameError('ELOG_CONFIG_MISSING', `log4j config ${id} is missing`, { file: id, path: file, url: client.file.url })
    }
  } else if (isLog4ShellAffected(version)) {
    args.push('-Dlog4j2.formatMsgNoLookups=true')
    warnings.push('No log4j config for a Log4Shell-affected version: added -Dlog4j2.formatMsgNoLookups=true (ignored by log4j older than 2.10)')
  }

  if (!hasPrefix(args, '-DlibraryDirectory')) args.push(`-DlibraryDirectory=${dirs.libraries}`)

  // User JVM arguments (or the version's defaults when none were configured).
  if (options.jvmArgs !== undefined) {
    args.push(...toArgv(options.jvmArgs))
  } else if (version.arguments.defaultUserJvm) {
    const defaults = expandArguments(version.arguments.defaultUserJvm, platform, features, jvmVars, warnings)
    const memorySet = minMB !== undefined || maxMB !== undefined
    args.push(...defaults.filter((a) => !(memorySet && (a.startsWith('-Xms') || a.startsWith('-Xmx')))))
  }

  args.push(version.mainClass)

  // Game arguments.
  const game = expandArguments(gameArgsJson, platform, features, vars, warnings)
  game.push(...toArgv(options.gameArgs))
  if (qp && !supportsQuickPlay) {
    if (qp.type === 'multiplayer') game.push('--server', qp.host, '--port', String(qp.port ?? 25565))
    else warnings.push(`Minecraft ${mc} does not support quick play into a ${qp.type === 'singleplayer' ? 'world' : 'realm'}; ignored`)
  }
  if (res) {
    if (res.fullscreen) {
      if (!game.includes('--fullscreen')) game.push('--fullscreen')
    } else if (customResolution && !game.includes('--width')) {
      game.push('--width', String(res.width), '--height', String(res.height))
    }
  }
  if (options.demo && !game.includes('--demo')) game.push('--demo')
  args.push(...game)

  const env = sanitizeEnv(options.baseEnv ?? process.env, options.env, warnings)
  return {
    java: options.java.path,
    args,
    wrapper: toArgv(options.wrapper),
    cwd: gameDir,
    env,
    secrets: [accessToken, session],
    warnings,
    natives: plan,
    nativesDir,
    classpath,
    features,
  }
}

/**
 * Suggested heap for "auto" memory (instances.md §3.5): `max = clamp(2048 + 512 × ceil(mods / 25),
 * 2048, min(RAM / 2, 16384))` and `min = min(1024, max)`, in MiB.
 */
export function autoMemory(modCount: number, physicalMB: number): { minMB: number; maxMB: number } {
  const cap = Math.max(2048, Math.min(Math.floor(physicalMB / 2), 16384))
  const maxMB = Math.min(cap, Math.max(2048, 2048 + 512 * Math.ceil(Math.max(0, modCount) / 25)))
  return { minMB: Math.min(1024, maxMB), maxMB }
}
