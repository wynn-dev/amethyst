/**
 * Account secrets: exactly one blob per account in `<data>/secrets/<hash of account id>.bin`,
 * encrypted by the main process with Electron `safeStorage` (Keychain-backed) and written
 * atomically with mode 0600. Nothing is ever stored in plaintext: when encryption is unavailable
 * the secrets live in memory for this session only.
 *
 * Each blob also records the account id it belongs to and is checked on read, so one account's
 * tokens can never be served for another. A blob that cannot be decrypted (the Keychain item
 * changed, e.g. after a re-sign) or does not parse reads as "unreadable": the account needs a
 * fresh sign-in, it never crashes anything.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { HostServices } from '@shared/services'
import { logger } from '../log'
import { errorCode } from '../util/errors'
import { isRecord } from '../util/parse'

const log = logger('secrets')

export interface AccountSecrets {
  accessToken: string
  accessTokenExpiresAt: number
  /** Microsoft accounts only. */
  msRefreshToken?: string
}

export type SecretRead = { ok: true; secrets: AccountSecrets } | { ok: false; reason: 'missing' | 'unreadable' }

interface Blob extends AccountSecrets {
  v: 1
  accountId: string
}

export class SecretStore {
  readonly #dir: string
  readonly #host: Pick<HostServices, 'encrypt' | 'decrypt'>
  /** Decrypted secrets (and memory-only ones when encryption is unavailable). */
  readonly #cache = new Map<string, AccountSecrets>()

  constructor(dir: string, host: Pick<HostServices, 'encrypt' | 'decrypt'>) {
    this.#dir = dir
    this.#host = host
  }

  /** The blob path for an account (a hash, so ids never become path components). */
  fileFor(accountId: string): string {
    return path.join(this.#dir, `${createHash('sha256').update(accountId).digest('hex').slice(0, 32)}.bin`)
  }

  /**
   * Store an account's secrets. Resolves `persisted: false` when encryption is unavailable: the
   * secrets are then kept in memory only and the user signs in again next session.
   */
  async put(accountId: string, secrets: AccountSecrets): Promise<{ persisted: boolean }> {
    const clean: AccountSecrets = { accessToken: secrets.accessToken, accessTokenExpiresAt: secrets.accessTokenExpiresAt }
    if (secrets.msRefreshToken) clean.msRefreshToken = secrets.msRefreshToken
    this.#cache.set(accountId, clean)
    const blob: Blob = { v: 1, accountId, ...clean }
    let cipher: string
    try {
      cipher = await this.#host.encrypt(JSON.stringify(blob))
    } catch (e) {
      log.warn(`encryption unavailable (${errorCode(e) ?? 'error'}); keeping credentials in memory only`)
      return { persisted: false }
    }
    await mkdir(this.#dir, { recursive: true, mode: 0o700 })
    const file = this.fileFor(accountId)
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
    try {
      const fh = await open(tmp, 'wx', 0o600)
      try {
        await fh.writeFile(cipher, 'utf8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      await rename(tmp, file)
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
    return { persisted: true }
  }

  async get(accountId: string): Promise<SecretRead> {
    const cached = this.#cache.get(accountId)
    if (cached) return { ok: true, secrets: { ...cached } }
    let cipher: string
    try {
      cipher = await readFile(this.fileFor(accountId), 'utf8')
    } catch (e) {
      return { ok: false, reason: errorCode(e) === 'ENOENT' ? 'missing' : 'unreadable' }
    }
    let plain: string
    try {
      plain = await this.#host.decrypt(cipher.trim())
    } catch (e) {
      log.warn(`cannot decrypt the credentials of an account (${errorCode(e) ?? 'error'}); it needs a new sign-in`)
      return { ok: false, reason: 'unreadable' }
    }
    try {
      const blob: unknown = JSON.parse(plain)
      if (!isRecord(blob) || blob.v !== 1 || blob.accountId !== accountId || typeof blob.accessToken !== 'string' || typeof blob.accessTokenExpiresAt !== 'number') {
        return { ok: false, reason: 'unreadable' }
      }
      const secrets: AccountSecrets = { accessToken: blob.accessToken, accessTokenExpiresAt: blob.accessTokenExpiresAt }
      if (typeof blob.msRefreshToken === 'string' && blob.msRefreshToken) secrets.msRefreshToken = blob.msRefreshToken
      this.#cache.set(accountId, secrets)
      return { ok: true, secrets: { ...secrets } }
    } catch {
      return { ok: false, reason: 'unreadable' }
    }
  }

  async delete(accountId: string): Promise<void> {
    this.#cache.delete(accountId)
    await rm(this.fileFor(accountId), { force: true })
  }
}
