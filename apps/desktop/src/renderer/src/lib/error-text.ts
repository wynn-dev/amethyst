import { toast } from '@/ui/toast-store'

/**
 * Service errors → UI text, keyed by the stable `code` (services.ts "Errors"). Messages from the
 * runtime are already written for people, so codes without an entry fall back to them.
 */

export interface ErrorLike {
  code?: string
  message: string
  details?: Record<string, unknown>
}

export function asError(e: unknown): ErrorLike {
  if (e && typeof e === 'object' && 'message' in e) {
    const o = e as { code?: unknown; message?: unknown; details?: unknown }
    return {
      message: String(o.message),
      ...(typeof o.code === 'string' ? { code: o.code } : {}),
      ...(o.details && typeof o.details === 'object' ? { details: o.details as Record<string, unknown> } : {}),
    }
  }
  return { message: String(e) }
}

const platformName = (p: unknown) => (p === 'curseforge' ? 'CurseForge' : p === 'modrinth' ? 'Modrinth' : 'the server')

const NETWORK = new Set(['ENETWORK', 'ETIMEOUT', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'ECONNABORTED'])

/** A short, friendly sentence for an error. */
export function errorMessage(e: unknown): string {
  const err = asError(e)
  const code = err.code ?? ''
  if (NETWORK.has(code)) return `Couldn’t reach ${platformName(err.details?.platform)}. Check your internet connection and try again.`
  switch (code) {
    case 'ERUNTIME_RESTARTED':
      return 'The background service restarted while this was running. Try again.'
    case 'ECANCELLED':
      return 'Cancelled.'
    case 'EUNAVAILABLE':
    case 'EMARKET_UNAVAILABLE':
    case 'ECF_NO_KEY':
      return err.details?.platform === 'curseforge' || code === 'ECF_NO_KEY' ? 'CurseForge isn’t available in this build.' : err.message
    case 'ECF_FORBIDDEN':
      return 'CurseForge rejected this build’s API key.'
    case 'ERATE_LIMITED':
      return `${platformName(err.details?.platform)} is limiting requests right now. Wait a minute and try again.`
    case 'EHTTP':
    case 'EBADRESPONSE':
    case 'EBAD_RESPONSE':
      return `${platformName(err.details?.platform)} returned an error. Try again later.`
    case 'ECHECKSUM':
    case 'ESIZE':
      return 'A download was damaged on the way (its checksum didn’t match). Try again.'
    case 'ENOSPC':
      return 'Your disk is full. Free some space and try again.'
    case 'EACCES':
    case 'EPERM':
    case 'EPERMISSION':
      return 'Amethyst isn’t allowed to access that file or folder.'
    case 'EUNSUPPORTED_FILE':
      return err.message || 'That kind of file can’t be added here.'
    case 'ENOT_A_WORLD':
      return 'That isn’t a Minecraft world (no level.dat was found).'
    case 'ENOT_A_ZIP':
    case 'EINVALID_ZIP':
    case 'EZIP_MALFORMED':
      return 'The file is damaged or isn’t a zip archive.'
    case 'EUNKNOWN_FORMAT':
    case 'EUNSUPPORTED_FORMAT':
    case 'EINVALID_MANIFEST':
      return 'This isn’t a modpack Amethyst can read (.mrpack or CurseForge zip).'
    case 'ENO_SHADER_LOADER':
      return 'Shaders need a shader mod: Iris (Fabric, Quilt, NeoForge) or Oculus (Forge).'
    case 'EMANUAL_DOWNLOAD_REQUIRED':
      return 'The author doesn’t allow launchers to download this file. Download it from CurseForge, then drop it here.'
    case 'EDIFFERENT_UPSTREAM':
      return 'This instance follows a different modpack.'
    default:
      return err.message || 'Something went wrong.'
  }
}

/** Show an error toast for a failed action ("Couldn’t install Sodium"), with Copy Details. */
export function reportError(title: string, e: unknown): void {
  const err = asError(e)
  if (err.code === 'ECANCELLED') {
    toast({ kind: 'info', title: `${title.replace(/^Couldn’t /, '')} cancelled`.replace(/^./, (c) => c.toUpperCase()) })
    return
  }
  toast({
    kind: 'error',
    title,
    message: errorMessage(err),
    actions: [{ label: 'Copy Details', onClick: () => void navigator.clipboard?.writeText(`${title}\n${err.code ?? ''} ${err.message}\n${err.details ? JSON.stringify(err.details) : ''}`.trim()) }],
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
