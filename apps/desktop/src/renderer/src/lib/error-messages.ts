import { toast } from '@/ui/toast-store'

/**
 * Turns service errors (`{ name, message, code, details }`) into plain-language text. One place,
 * keyed by the stable `code`, so every surface (toasts, sheets, banners) says the same thing.
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

const NETWORK = new Set(['EHTTP', 'ENETWORK', 'ETIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EOFFLINE', 'UND_ERR_CONNECT_TIMEOUT'])

/** Codes whose message from the service is already written for people. */
const SERVICE_WORDED = new Set(['EBUSY', 'ENOT_FOUND', 'EINVALID_ARGUMENT', 'EINVALID_SETTINGS', 'EUNAVAILABLE', 'EINSTANCE_UNAVAILABLE', 'EOFFLINE_NAME_REQUIRED', 'EOFFLINE_NAME_LENGTH', 'EOFFLINE_NAME_CYRILLIC', 'EOFFLINE_NAME_CHARS', 'EOFFLINE_UUID_INVALID'])

const TABLE: Record<string, (e: unknown) => Omit<FriendlyError, 'code' | 'link'>> = {
  ERUNTIME_RESTARTED: () => ({ title: 'The background service restarted', message: 'Nothing was lost. Try again.' }),
  ENOMETHOD: () => ({ title: 'This isn’t available in this version of Amethyst' }),
  ECANCELLED: () => ({ title: 'Cancelled' }),
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
  ESIGN_IN_REQUIRED: () => ({ title: 'Your Microsoft session expired', message: 'Sign in again to keep playing online.' }),
  EPRELAUNCH_FAILED: (e) => {
    const code = errorDetails(e).exitCode
    return { title: 'The pre-launch command failed', message: `It exited with ${typeof code === 'number' ? `code ${code}` : 'a signal'}. Check it in the instance’s Settings tab.` }
  },
  EINSTALL_INCOMPLETE: (e) => ({ title: 'Some game files couldn’t be downloaded', message: rawMessage(e) }),
  EINSTALL_NOT_FOUND: (e) => ({ title: 'This version couldn’t be found', message: rawMessage(e) }),
  ELAUNCH_FAILED: (e) => ({ title: 'The game couldn’t start', message: rawMessage(e) }),
  ENOUPDATE: () => ({ title: 'No update is ready to install yet' }),
  EJAVA_INVALID: (e) => ({ title: 'That isn’t a usable Java runtime', message: javaReason(errorDetails(e).reason) ?? rawMessage(e) }),
  EUNSUPPORTED_MEDIA: () => ({ title: 'That file type isn’t supported' }),
  EOPEN_FAILED: (e) => ({ title: 'Couldn’t open the folder', message: rawMessage(e) }),
  // Accounts
  EOFFLINE_NOT_ALLOWED: () => ({
    title: 'Offline accounts need a Microsoft account first',
    message: 'Add the Microsoft account that owns Minecraft, then you can add offline players. Developers can turn on Developer mode in Settings → Advanced.',
  }),
  EMSA_APP_NOT_APPROVED: () => ({
    title: 'Microsoft sign-in isn’t approved for this build',
    message: 'Mojang has to approve every launcher before it may sign in to Minecraft, and this build’s Microsoft app isn’t approved yet. Offline accounts still work for single-player.',
  }),
  EXSTS_NO_ACCOUNT: () => ({ title: 'This Microsoft account has no Xbox profile', message: 'Sign in once at xbox.com to create one, then try again.' }),
  EXSTS_CHILD_NOT_IN_FAMILY: () => ({ title: 'An adult needs to add this account to a Microsoft family', message: 'Accounts of people under 18 must be part of a family group to play.' }),
  EXSTS_REGION_UNAVAILABLE: () => ({ title: 'Xbox Live isn’t available in this account’s country or region' }),
  EXSTS_BANNED: () => ({ title: 'This Xbox account is banned' }),
  EXSTS_TERMS_NOT_ACCEPTED: () => ({ title: 'Accept the Xbox terms first', message: 'Sign in at xbox.com and accept the terms, then try again.' }),
  EXSTS_AGE_VERIFICATION: () => ({ title: 'This account needs age verification', message: 'Complete it at xbox.com, then try again.' }),
  EXSTS_PARENTAL_CONTROLS: () => ({ title: 'Parental controls block signing in' }),
  EXSTS_SERVICE_OUTAGE: () => ({ title: 'Xbox Live is having problems', message: 'Try again in a few minutes.' }),
  EMC_NOT_OWNED: () => ({ title: 'This account doesn’t own Minecraft: Java Edition', message: 'Buy it at minecraft.net, or sign in with the account that owns it.' }),
  EMC_NO_PROFILE: () => ({ title: 'This account has no Minecraft profile yet', message: 'Open minecraft.net, sign in and choose a player name, then try again.' }),
  EMC_RATE_LIMITED: () => ({ title: 'Too many sign-in attempts', message: 'Wait a few minutes and try again.' }),
  EMC_ACCOUNT_SUSPENDED: () => ({ title: 'This Minecraft account is suspended' }),
  EDEVICE_EXPIRED: () => ({ title: 'The code expired', message: 'Start again to get a new code.' }),
  EDEVICE_DECLINED: () => ({ title: 'Sign-in was declined' }),
  ELOGIN_TIMEOUT: () => ({ title: 'Sign-in timed out', message: 'Start again when you’re ready.' }),
  EMSA_CANCELLED: () => ({ title: 'Sign-in was cancelled' }),
  EAUTH_WINDOW: () => ({ title: 'The sign-in page couldn’t load', message: 'Check your internet connection, or sign in with your browser instead.' }),
  ESECRET_UNAVAILABLE: () => ({ title: 'The macOS Keychain isn’t available', message: 'Amethyst can’t store the sign-in securely, so it is kept for this session only.' }),
  EACCOUNT_MISMATCH: () => ({ title: 'That’s a different Microsoft account', message: 'Sign in with the account you added before.' }),
}

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

/** Plain-language text for an error. */
export function describeError(e: unknown): FriendlyError {
  const code = errorCode(e)
  const link = typeof errorDetails(e).link === 'string' ? (errorDetails(e).link as string) : undefined
  const base = { ...(code ? { code } : {}), ...(link ? { link } : {}) }
  if (code && TABLE[code]) return { ...TABLE[code](e), ...base }
  if (code && NETWORK.has(code)) return { title: 'Couldn’t connect', message: 'Check your internet connection and try again.', ...base }
  if (code && SERVICE_WORDED.has(code)) return { title: rawMessage(e), ...base }
  if (code?.startsWith('EINSTALL_')) return { title: 'Installing the game failed', message: rawMessage(e), ...base }
  if (code?.startsWith('EXSTS_') || code?.startsWith('EMSA_') || code?.startsWith('EMC_')) return { title: 'Signing in failed', message: rawMessage(e), ...base }
  return { title: rawMessage(e) || 'Something went wrong', ...base }
}

/** One line for inline use: title plus message. */
export function errorText(e: unknown): string {
  const f = describeError(e)
  return f.message ? `${f.title}. ${f.message}` : f.title
}

/** An error toast with the mapped text and "Copy Details". Cancellations are silent by design. */
export function toastError(e: unknown, context?: string): void {
  if (errorCode(e) === 'ECANCELLED') return
  const f = describeError(e)
  const title = context ?? f.title
  const message = context ? (f.message ? `${f.title}. ${f.message}` : f.title) : f.message
  toast({
    kind: 'error',
    title,
    ...(message ? { message } : {}),
    actions: [
      {
        label: 'Copy Details',
        onClick: () => void navigator.clipboard?.writeText(`${title}\n${f.code ?? ''} ${rawMessage(e)}`.trim()),
      },
    ],
  })
}
