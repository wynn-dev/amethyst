import { toast } from '@/ui/toast-store'

/**
 * Turns service errors (`{ name, message, code, details }`) into plain-language text. One place,
 * keyed by the stable `code` (services.ts "Errors"), so every surface (toasts, sheets, banners)
 * says the same thing. Codes without an entry fall back to the runtime's message, which is
 * already written for people.
 */

export interface FriendlyError {
  /** Short sentence. */
  title: string
  /** Optional explanation or next step. */
  message?: string
  code?: string
  /** A help page from the service (`details.link`), when there is one. */
  link?: string
}

export function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

export function errorDetails(e: unknown): Record<string, unknown> {
  const d = (e as { details?: unknown } | null)?.details
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : {}
}

function rawMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message
  return String(e)
}

/** "Modrinth", "CurseForge" or "the server", from `details.platform`. */
function platformName(e: unknown): string {
  const p = errorDetails(e).platform
  return p === 'curseforge' ? 'CurseForge' : p === 'modrinth' ? 'Modrinth' : 'the server'
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Ends `s` with a full stop unless it already ends with punctuation. */
const sentence = (s: string) => (/[.!?…:]$/.test(s.trimEnd()) ? s.trimEnd() : `${s.trimEnd()}.`)

/** Node, undici and net failures that mean the network is down or the host is unreachable. */
const NETWORK = new Set([
  'ENETWORK',
  'EOFFLINE',
  'ETIMEOUT',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'ERR_HTTP2_STREAM_ERROR',
  'ERR_HTTP2_SESSION_ERROR',
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_STREAM_PREMATURE_CLOSE',
])

/** Codes whose message from the service is already written for people. */
const SERVICE_WORDED = new Set([
  'EBUSY',
  'ENOT_FOUND',
  'EINVALID_ARGUMENT',
  'EINVALID_SETTINGS',
  'EINSTANCE_UNAVAILABLE',
  'EINVALID_NAME',
  'ENAME_TAKEN',
  'EUNSUPPORTED',
  'EFAILED',
  'ENO_COMPATIBLE_VERSION',
  'EOFFLINE_NAME_REQUIRED',
  'EOFFLINE_NAME_LENGTH',
  'EOFFLINE_NAME_CYRILLIC',
  'EOFFLINE_NAME_CHARS',
  'EOFFLINE_UUID_INVALID',
])

type Describe = (e: unknown) => Omit<FriendlyError, 'code' | 'link'>

const curseforgeUnavailable: Describe = () => ({ title: 'CurseForge isn’t available in this build' })
const unavailable: Describe = (e) => (errorDetails(e).platform === 'curseforge' ? curseforgeUnavailable(e) : { title: rawMessage(e) || 'This isn’t available right now' })
const badServerResponse: Describe = (e) => ({ title: `${capitalize(platformName(e))} returned an error`, message: 'Try again later.' })
const damagedDownload: Describe = () => ({ title: 'A download was damaged on the way', message: 'Its checksum didn’t match. Try again.' })
const noPermission: Describe = () => ({ title: 'Amethyst isn’t allowed to access that file or folder', message: 'Check its permissions in Finder, then try again.' })
const notAZip: Describe = () => ({ title: 'The file is damaged or isn’t a zip archive' })
const notAModpack: Describe = () => ({ title: 'This isn’t a modpack Amethyst can read', message: 'Use a .mrpack file or a CurseForge modpack zip.' })
const versionDamaged: Describe = () => ({ title: 'This version’s files are damaged', message: 'Choose Repair Files from the instance’s menu, then try again.' })
const versionFileMissing: Describe = () => ({ title: 'Some of this version’s files are missing', message: 'Choose Repair Files from the instance’s menu, then try again.' })
const javaDownloadDamaged: Describe = () => ({ title: 'The Java download was damaged', message: 'Try again.' })
const loaderInstallerFailed: Describe = () => ({ title: 'The mod loader’s installer failed', message: 'Try again, or choose a different loader version.' })
const sessionExpired: Describe = () => ({ title: 'Your Microsoft session expired', message: 'Sign in again to keep playing online.' })
const signInIncomplete: Describe = () => ({ title: 'Microsoft sign-in didn’t finish', message: 'Try signing in again.' })
const invalidSkin: Describe = () => ({ title: 'This image isn’t a valid skin', message: 'Skins are PNG files of 64 × 64 or 64 × 32 pixels.' })

const TABLE: Record<string, Describe> = {
  // General
  ERUNTIME_RESTARTED: () => ({ title: 'The background service restarted', message: 'Nothing was lost. Try again.' }),
  ENOMETHOD: () => ({ title: 'This isn’t available in this version of Amethyst' }),
  ECANCELLED: () => ({ title: 'Cancelled' }),
  EUNAVAILABLE: unavailable,
  ENOSPC: () => ({ title: 'Your disk is full', message: 'Free up some space and try again.' }),
  EROFS: () => ({ title: 'That disk is read-only', message: 'Choose a folder on a disk you can write to.' }),
  EACCES: noPermission,
  EPERM: noPermission,
  EPERMISSION: noPermission,
  ENOENT: () => ({ title: 'That file or folder no longer exists' }),
  EEXIST: () => ({ title: 'Something with that name already exists', message: 'Rename it or choose another name, then try again.' }),
  EOPEN_FAILED: (e) => ({ title: 'Couldn’t open the folder', message: rawMessage(e) }),
  EUNSUPPORTED_MEDIA: () => ({ title: 'That file type isn’t supported' }),
  ENOUPDATE: () => ({ title: 'No update is ready to install yet' }),
  EDOCUMENT_READONLY: (e) => ({ title: 'Changes can’t be saved', message: rawMessage(e) }),
  EDB_RESTARTED: () => ({ title: 'The content index restarted', message: 'Nothing was lost. Try again.' }),
  EWORKER_CRASHED: () => ({ title: 'The content scanner restarted', message: 'Nothing was lost. Try again.' }),
  EDB_UNAVAILABLE: () => ({ title: 'The content index isn’t available', message: 'Quit and reopen Amethyst to try again.' }),
  EDB_OPEN_FAILED: () => ({ title: 'The content index couldn’t be opened', message: 'Quit and reopen Amethyst to try again.' }),

  // Downloads and marketplaces
  EMARKET_UNAVAILABLE: unavailable,
  ECF_NO_KEY: curseforgeUnavailable,
  ECF_FORBIDDEN: () => ({ title: 'CurseForge rejected this build’s API key' }),
  ERATE_LIMITED: (e) => ({ title: `${capitalize(platformName(e))} is limiting requests right now`, message: 'Wait a minute and try again.' }),
  EHTTP: badServerResponse,
  EBADRESPONSE: badServerResponse,
  EBAD_RESPONSE: badServerResponse,
  ECHECKSUM: damagedDownload,
  ESIZE: damagedDownload,
  EDOWNLOAD: () => ({ title: 'Some files couldn’t be downloaded', message: 'Check your internet connection and try again.' }),
  ECONFLICT: () => ({ title: 'That file is already downloading', message: 'Wait for the other download to finish, then try again.' }),
  ENO_FILE: () => ({ title: 'This version has no file to download' }),
  EMANUAL_DOWNLOAD_REQUIRED: () => ({ title: 'The author doesn’t allow launchers to download this file', message: 'Download it from CurseForge, then drop it here.' }),

  // Files, content and modpacks
  EUNSUPPORTED_FILE: (e) => ({ title: rawMessage(e) || 'That kind of file can’t be added here' }),
  ENOT_A_WORLD: () => ({ title: 'That isn’t a Minecraft world', message: 'No level.dat was found.' }),
  ENOT_A_ZIP: notAZip,
  EINVALID_ZIP: notAZip,
  EZIP_MALFORMED: notAZip,
  EZIP_TOO_LARGE: () => ({ title: 'A file in the archive is too large to read' }),
  EZIP_NOT_FOUND: (e) => ({ title: 'The archive is missing a file it needs', message: rawMessage(e) }),
  EZIP_UNSAFE_PATH: () => ({ title: 'The archive contains unsafe file paths', message: 'Amethyst didn’t extract it. Only use files from sources you trust.' }),
  ENBT_MALFORMED: () => ({ title: 'A Minecraft data file is damaged', message: 'It couldn’t be read.' }),
  EUNKNOWN_FORMAT: notAModpack,
  EUNSUPPORTED_FORMAT: notAModpack,
  EINVALID_MANIFEST: notAModpack,
  ENOT_A_FILE: () => ({ title: 'The modpack file is missing', message: 'It may have been moved or deleted.' }),
  ENO_SHADER_LOADER: () => ({ title: 'Shaders need a shader mod', message: 'Add Iris (Fabric, Quilt, NeoForge) or Oculus (Forge).' }),
  EDIFFERENT_UPSTREAM: () => ({ title: 'This instance follows a different modpack' }),
  EINSTANCE_GONE: () => ({ title: 'The instance was moved or deleted while this was running' }),
  ECOMMIT: () => ({ title: 'Couldn’t apply the changes', message: 'Everything was rolled back, so the instance is as it was.' }),
  EUNSAFE_PATH: (e) => ({ title: 'A folder in this instance is a link to somewhere else', message: `Amethyst won’t write through it. ${rawMessage(e)}` }),
  EALREADY_ROLLED_BACK: () => ({ title: 'This backup was already restored', message: 'Restoring it again would undo your changes since.' }),
  EMODPACK_INTERRUPTED: (e) => ({ title: 'An interrupted modpack change couldn’t be undone', message: rawMessage(e) }),
  EINSTALL_FAILED: (e) => ({ title: 'Installing failed', message: rawMessage(e) }),
  ETRASH_FAILED: (e) => ({ title: 'Couldn’t move it to the Trash', message: rawMessage(e) }),
  ERESCUE_FAILED: () => ({ title: 'Couldn’t move the world out of the instance', message: 'Nothing was deleted.' }),
  EIMPORT_REJECTED: () => ({ title: 'This folder can’t be imported', message: 'It doesn’t look like a Minecraft instance.' }),

  // Installing the game
  EINSTALL_INCOMPLETE: (e) => ({ title: 'Some game files couldn’t be downloaded', message: rawMessage(e) }),
  EINSTALL_NOT_FOUND: (e) => ({ title: 'This version couldn’t be found', message: rawMessage(e) }),
  EINSTALL_BAD_METADATA: () => ({ title: 'Version information couldn’t be read', message: 'Try again later.' }),
  EINSTALL_BAD_INSTALLER: () => ({ title: 'The mod loader’s installer is damaged or unsupported', message: 'Try a different loader version.' }),
  EINSTALL_UNVERIFIED: () => ({ title: 'A download couldn’t be verified', message: 'Amethyst doesn’t run files it can’t check. Try again later.' }),
  EINSTALL_CHECKSUM: damagedDownload,
  EINSTALL_FILE_INVALID: () => ({ title: 'A downloaded file was damaged', message: 'Try again.' }),
  EINSTALL_UNKNOWN_VARIABLE: loaderInstallerFailed,
  EINSTALL_PROCESSOR_BAD_JAR: loaderInstallerFailed,
  EINSTALL_PROCESSOR_NO_MAIN_CLASS: loaderInstallerFailed,
  EINSTALL_PROCESSOR_FAILED: loaderInstallerFailed,
  EINSTALL_PROCESSOR_OUTPUT: loaderInstallerFailed,
  EINSTALL_NO_JAVA: () => ({ title: 'Installing this mod loader needs Java', message: 'Install Java in Settings, then try again.' }),
  EINSTALL_UNSUPPORTED: (e) => ({ title: 'This combination isn’t supported', message: rawMessage(e) }),

  // Launch
  EJAVA_REQUIRED: (e) => {
    const major = errorDetails(e).major
    return { title: `Minecraft needs Java ${typeof major === 'number' ? major : ''}`.trim(), message: 'Amethyst can download a native Apple silicon runtime for you.' }
  },
  ENATIVES_UNAVAILABLE: () => ({
    title: 'This version can’t run on Apple silicon yet',
    message: 'Amethyst runs every version natively and never uses Rosetta, but native libraries for this Minecraft version haven’t been published yet. Try a newer version.',
  }),
  EACCOUNT_REQUIRED: () => ({ title: 'Add an account to play', message: 'Sign in with Microsoft, or add an offline account for single-player.' }),
  ESIGN_IN_REQUIRED: sessionExpired,
  EPRELAUNCH_FAILED: (e) => {
    const code = errorDetails(e).exitCode
    return { title: 'The pre-launch command failed', message: `It exited with ${typeof code === 'number' ? `code ${code}` : 'a signal'}. Check it in the instance’s Settings tab.` }
  },
  ELAUNCH_FAILED: (e) => ({ title: 'The game couldn’t start', message: rawMessage(e) }),
  ELAUNCH_SPAWN: (e) => ({ title: 'The game couldn’t start', message: rawMessage(e) }),
  ELAUNCH_OPTIONS: (e) => ({ title: 'The launch settings aren’t valid', message: rawMessage(e) }),
  ELAUNCH_JAVA_NOT_FOUND: () => ({ title: 'Java couldn’t be found', message: 'Choose another Java runtime in the instance’s Settings tab.' }),
  ELAUNCH_JAVA_PERMISSION: () => ({ title: 'Java isn’t allowed to run', message: 'Choose another Java runtime in the instance’s Settings tab.' }),
  EVERSION_MISSING: versionFileMissing,
  EVERSION_CORRUPT: versionDamaged,
  EVERSION_INVALID: versionDamaged,
  EVERSION_CYCLE: versionDamaged,
  ELIBRARY_PATH: versionDamaged,
  ELOG_CONFIG_MISSING: versionFileMissing,
  EASSET_INDEX: versionDamaged,
  ENATIVES_EXTRACT: () => ({ title: 'Couldn’t prepare the game’s native libraries', message: 'Try again.' }),

  // Java
  EJAVA_INVALID: (e) => ({ title: 'That isn’t a usable Java runtime', message: javaReason(errorDetails(e).reason) ?? rawMessage(e) }),
  EJAVA_PROBE: (e) => ({ title: 'That isn’t a usable Java runtime', message: rawMessage(e) }),
  EJAVA_TIMEOUT: () => ({ title: 'Java didn’t respond in time', message: 'Try again.' }),
  EBADARCH: () => ({ title: 'This Java runtime isn’t built for Apple silicon', message: 'Amethyst can download a native one for you.' }),
  ENORUNTIME: () => ({ title: 'No Apple silicon Java runtime is available for this version' }),
  EBADMANIFEST: () => ({ title: 'The list of Java downloads couldn’t be read', message: 'Try again later.' }),
  EUNSAFEPATH: javaDownloadDamaged,
  EBADARCHIVE: javaDownloadDamaged,
  ELZMA: javaDownloadDamaged,
  EVERIFY: () => ({ title: 'The Java runtime is damaged and couldn’t be repaired', message: 'Remove it in Settings, then try again.' }),
  EINSTALL: () => ({ title: 'Java couldn’t be installed', message: 'Check your internet connection and try again.' }),

  // Accounts
  EOFFLINE_NOT_ALLOWED: () => ({
    title: 'Offline accounts need a Microsoft account first',
    message: 'Add the Microsoft account that owns Minecraft, then you can add offline players. Developers can turn on Developer mode in Settings → Advanced.',
  }),
  EMSA_APP_NOT_APPROVED: () => ({
    title: 'Microsoft sign-in isn’t approved for this build',
    message: 'Mojang has to approve every launcher before it may sign in to Minecraft, and this build’s Microsoft app isn’t approved yet. Offline accounts still work for single-player.',
  }),
  EMSA_INVALID_GRANT: sessionExpired,
  EMSA_INTERACTION_REQUIRED: sessionExpired,
  ESESSION_INVALID: sessionExpired,
  EMC_UNAUTHORIZED: sessionExpired,
  EMSA_TOKEN_FAILED: signInIncomplete,
  EMSA_NO_REFRESH_TOKEN: signInIncomplete,
  EMSA_STATE_MISMATCH: signInIncomplete,
  EMSA_NO_CODE: signInIncomplete,
  EMSA_CANCELLED: () => ({ title: 'Sign-in was cancelled' }),
  EXBL_FAILED: () => ({ title: 'Couldn’t sign in to Xbox Live', message: 'Try again in a few minutes.' }),
  EXSTS_NO_ACCOUNT: () => ({ title: 'This Microsoft account has no Xbox profile', message: 'Sign in once at xbox.com to create one, then try again.' }),
  EXSTS_CHILD_NOT_IN_FAMILY: () => ({ title: 'An adult needs to add this account to a Microsoft family', message: 'Accounts of people under 18 must be part of a family group to play.' }),
  EXSTS_REGION_UNAVAILABLE: () => ({ title: 'Xbox Live isn’t available in this account’s country or region' }),
  EXSTS_BANNED: () => ({ title: 'This Xbox account is banned' }),
  EXSTS_TERMS_NOT_ACCEPTED: () => ({ title: 'Accept the Xbox terms first', message: 'Sign in at xbox.com and accept the terms, then try again.' }),
  EXSTS_AGE_VERIFICATION: () => ({ title: 'This account needs age verification', message: 'Complete it at xbox.com, then try again.' }),
  EXSTS_PARENTAL_CONTROLS: () => ({ title: 'Parental controls block signing in' }),
  EXSTS_SERVICE_OUTAGE: () => ({ title: 'Xbox Live is having problems', message: 'Try again in a few minutes.' }),
  EXSTS_UNKNOWN: () => ({ title: 'Xbox Live refused the sign-in', message: 'Try again in a few minutes.' }),
  EXSTS_BAD_RESPONSE: () => ({ title: 'Xbox Live refused the sign-in', message: 'Try again in a few minutes.' }),
  EMC_NOT_OWNED: () => ({ title: 'This account doesn’t own Minecraft: Java Edition', message: 'Buy it at minecraft.net, or sign in with the account that owns it.' }),
  EMC_NO_PROFILE: () => ({ title: 'This account has no Minecraft profile yet', message: 'Open minecraft.net, sign in and choose a player name, then try again.' }),
  EMC_RATE_LIMITED: () => ({ title: 'Too many sign-in attempts', message: 'Wait a few minutes and try again.' }),
  EMC_ACCOUNT_SUSPENDED: () => ({ title: 'This Minecraft account is suspended' }),
  EMC_SERVICE_ERROR: () => ({ title: 'Couldn’t sign in to Minecraft', message: 'Minecraft services may be having problems. Try again in a few minutes.' }),
  EMC_LOGIN_FAILED: () => ({ title: 'Couldn’t sign in to Minecraft', message: 'Minecraft services may be having problems. Try again in a few minutes.' }),
  EMC_PROFILE_FAILED: () => ({ title: 'Couldn’t load the Minecraft profile', message: 'Try again in a few minutes.' }),
  EDEVICE_EXPIRED: () => ({ title: 'The code expired', message: 'Start again to get a new code.' }),
  EDEVICE_DECLINED: () => ({ title: 'Sign-in was declined' }),
  EDEVICE_BAD_CODE: () => ({ title: 'The sign-in code didn’t work', message: 'Start again to get a new code.' }),
  ELOGIN_TIMEOUT: () => ({ title: 'Sign-in timed out', message: 'Start again when you’re ready.' }),
  EAUTH_WINDOW: () => ({ title: 'The sign-in page couldn’t load', message: 'Check your internet connection, or sign in with your browser instead.' }),
  ESECRET_UNAVAILABLE: () => ({ title: 'The macOS Keychain isn’t available', message: 'Amethyst can’t store the sign-in securely, so it is kept for this session only.' }),
  EACCOUNT_MISMATCH: () => ({ title: 'That’s a different Microsoft account', message: 'Sign in with the account you added before.' }),
  ESKIN_INVALID_PNG: invalidSkin,
  ESKIN_BAD_DIMENSIONS: invalidSkin,
  ESKIN_TOO_LARGE: () => ({ title: 'This file is too large to be a skin' }),
  ESKIN_REJECTED_IMAGE: () => ({ title: 'Minecraft rejected this image', message: 'It’s invalid or not allowed.' }),
  ESKIN_REJECTED: () => ({ title: 'Minecraft couldn’t change the skin', message: 'Try again later.' }),
  ECAPE_INVALID: () => ({ title: 'This account doesn’t own that cape' }),
}

/** Every code with a dedicated mapping (for tests). */
export const MAPPED_CODES: ReadonlySet<string> = new Set([...Object.keys(TABLE), ...NETWORK, ...SERVICE_WORDED])

function javaReason(reason: unknown): string | undefined {
  switch (reason) {
    case 'missing':
      return 'The file doesn’t exist.'
    case 'not-executable':
      return 'The file can’t be run.'
    case 'bad-cpu-type':
      return 'It was built for a different processor.'
    case 'timeout':
      return 'It didn’t answer in time.'
    case 'unparseable':
      return 'Its version couldn’t be read.'
    default:
      return undefined
  }
}

/** Plain-language text for an error: a short title and an optional next step. */
export function describeError(e: unknown): FriendlyError {
  const code = errorCode(e)
  const link = typeof errorDetails(e).link === 'string' ? (errorDetails(e).link as string) : undefined
  const base = { ...(code ? { code } : {}), ...(link ? { link } : {}) }
  if (code && TABLE[code]) return { ...TABLE[code](e), ...base }
  if (code && NETWORK.has(code)) {
    const p = platformName(e)
    return { title: p === 'the server' ? 'Couldn’t connect' : `Couldn’t reach ${p}`, message: 'Check your internet connection and try again.', ...base }
  }
  if (code && SERVICE_WORDED.has(code)) return { title: rawMessage(e) || 'Something went wrong', ...base }
  if (code?.startsWith('EINSTALL_')) return { title: 'Installing the game failed', message: rawMessage(e), ...base }
  if (code?.startsWith('EVERSION_')) return { ...versionDamaged(e), ...base }
  if (code?.startsWith('EXSTS_') || code?.startsWith('EMSA_') || code?.startsWith('EMC_')) return { title: 'Signing in failed', message: rawMessage(e), ...base }
  return { title: rawMessage(e) || 'Something went wrong', ...base }
}

/** The mapped text as one or two sentences, for inline use (banners, rows, empty states). */
export function errorMessage(e: unknown): string {
  const f = describeError(e)
  return f.message ? `${sentence(f.title)} ${sentence(f.message)}` : sentence(f.title)
}

function copyDetails(title: string, e: unknown): string {
  const details = errorDetails(e)
  return [title, `${errorCode(e) ?? ''} ${rawMessage(e)}`.trim(), Object.keys(details).length ? JSON.stringify(details) : ''].filter(Boolean).join('\n')
}

/**
 * An error toast with the mapped text and "Copy Details". With `context` (a failed action such as
 * "Couldn’t install Sodium") that becomes the title and the mapped text the message.
 * Cancellations are silent by design.
 */
export function toastError(e: unknown, context?: string): void {
  if (errorCode(e) === 'ECANCELLED') return
  const f = describeError(e)
  const title = context ?? f.title
  const message = context ? errorMessage(e) : f.message
  toast({
    kind: 'error',
    title,
    ...(message ? { message } : {}),
    actions: [{ label: 'Copy Details', onClick: () => void navigator.clipboard?.writeText(copyDetails(title, e)) }],
  })
}

/** Toast for a bulk result: success, partial success or failure. */
export function reportBulk(result: { done: string[]; failed: { id: string; code: string; message: string }[] }, what: { done: (n: number) => string; failed: string }): void {
  if (result.failed.length === 0) {
    if (result.done.length > 0) toast({ kind: 'success', title: what.done(result.done.length) })
    return
  }
  const first = result.failed[0]!
  toast({
    kind: result.done.length ? 'warning' : 'error',
    title: result.done.length ? `${what.done(result.done.length)}, ${result.failed.length} failed` : what.failed,
    message: `${first.id.split('/').pop()}: ${errorMessage(first)}${result.failed.length > 1 ? ` (+${result.failed.length - 1} more)` : ''}`,
    actions: [{ label: 'Copy Details', onClick: () => void navigator.clipboard?.writeText(result.failed.map((f) => `${f.id}: ${f.code} ${f.message}`).join('\n')) }],
  })
}
