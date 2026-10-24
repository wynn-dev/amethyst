/**
 * Accounts (accounts spec): Microsoft sign-in through `@amethyst/auth` (embedded window via the
 * main process, system browser with a loopback redirect, or device code), offline profiles,
 * silent single-flight refresh, skins and capes.
 *
 * `accounts.json` holds public fields only; tokens live in {@link SecretStore} (one encrypted
 * blob per account) and never cross IPC. Records are published from disk immediately at boot;
 * nothing here waits on the network unless the user asked for it.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AuthError,
  createAuthorizationRequest,
  createOfflineSession,
  currentTextures,
  exchangeCode,
  hideCape,
  loginMicrosoft,
  needsRefresh,
  parseAuthorizationResponse,
  parseProfile,
  pollDeviceCode,
  refreshMicrosoft,
  resetSkin,
  showCape,
  startDeviceCode,
  startLoopbackServer,
  toPublicAccount,
  uploadSkin,
  validateSkinPng,
  type AccountSession,
  type MinecraftProfile,
  type MsTokens,
  type PublicAccount,
  type Session,
} from '@amethyst/auth'
import { assetUrl } from '@shared/paths'
import type { AccountDetail, AccountRow, AccountsService, AccountsStatus, HostServices, MicrosoftLoginMethod, Settings, SkinSource } from '@shared/services'
import type { Emit } from '../context'
import type { DataLayout } from '../layout'
import { logger } from '../log'
import { JsonDocument } from '../store/json-store'
import { AppError, errorCode, invalid, notFound } from '../util/errors'
import { decodeDataUrl } from '../util/media'
import { asRecord, isRecord, readBool, readOneOf, readString } from '../util/parse'
import { SecretStore, type AccountSecrets } from './secrets'

const log = logger('accounts')

/** The `@amethyst/auth` calls used here (injectable for tests). */
export interface AuthApi {
  createAuthorizationRequest: typeof createAuthorizationRequest
  parseAuthorizationResponse: typeof parseAuthorizationResponse
  exchangeCode: typeof exchangeCode
  startLoopbackServer: typeof startLoopbackServer
  startDeviceCode: typeof startDeviceCode
  pollDeviceCode: typeof pollDeviceCode
  loginMicrosoft: typeof loginMicrosoft
  refreshMicrosoft: typeof refreshMicrosoft
  uploadSkin: typeof uploadSkin
  resetSkin: typeof resetSkin
  showCape: typeof showCape
  hideCape: typeof hideCape
}

const defaultAuth: AuthApi = {
  createAuthorizationRequest,
  parseAuthorizationResponse,
  exchangeCode,
  startLoopbackServer,
  startDeviceCode,
  pollDeviceCode,
  loginMicrosoft,
  refreshMicrosoft,
  uploadSkin,
  resetSkin,
  showCape,
  hideCape,
}

/** A persisted account record: public fields plus local state. */
type StoredAccount = PublicAccount & {
  /** The last refresh failed definitively (or the credentials are unreadable): sign in again. */
  invalidated?: boolean
  /** Offline accounts: a launcher-only skin under `skins/`. */
  localSkin?: { file: string; model: 'classic' | 'slim' }
}

interface AccountsDoc {
  selectedId: string | null
  accounts: StoredAccount[]
}

export interface AccountManagerDeps {
  layout: DataLayout
  emit: Emit
  host: Pick<HostServices, 'encrypt' | 'decrypt' | 'openAuthWindow' | 'closeAuthWindow' | 'openExternal'>
  settings: { readonly value: Settings }
  /** Azure application id; Microsoft login is unavailable without it. */
  msaClientId?: string
  auth?: Partial<AuthApi>
  fetchBytes?: (url: string, options: { maxBytes: number; signal?: AbortSignal }) => Promise<Uint8Array>
  now?: () => number
}

const MAX_SKIN_BYTES = 256 * 1024
const APP_NOT_APPROVED =
  'Microsoft sign-in is not available in this build yet: its Azure app has not been approved by Mojang for the Minecraft API. ' +
  'Use an official Amethyst build, or (for developers) finish the approval at https://aka.ms/AppRegInfo.'

/** Parse one stored record; invalid records are dropped one at a time. */
function parseStoredAccount(raw: unknown): StoredAccount | undefined {
  if (!isRecord(raw)) return undefined
  const id = readString(raw.id)
  const kind = readOneOf(raw.kind, ['microsoft', 'offline'] as const)
  const username = readString(raw.username)
  const uuid = readString(raw.uuid)
  if (!id || !kind || !username || !uuid) return undefined
  const profile = parseProfile({ id: uuid, name: username, skins: raw.skins, capes: raw.capes })
  const base = {
    id,
    username,
    uuid,
    accessTokenExpiresAt: typeof raw.accessTokenExpiresAt === 'number' ? raw.accessTokenExpiresAt : 0,
    skins: profile?.skins ?? [],
    capes: profile?.capes ?? [],
  }
  const out: StoredAccount = kind === 'offline' ? { ...base, kind } : { ...base, kind }
  if (kind === 'microsoft') {
    for (const key of ['xuid', 'gamertag', 'avatar', 'msAccountId', 'loginHint'] as const) {
      const v = readString(raw[key])
      if (v) (out as Record<string, unknown>)[key] = v
    }
  }
  if (readBool(raw.invalidated)) out.invalidated = true
  const skin = asRecord(raw.localSkin)
  const file = readString(skin.file)
  const model = readOneOf(skin.model, ['classic', 'slim'] as const)
  if (kind === 'offline' && file && /^[\w.-]+\.png$/.test(file) && model) out.localSkin = { file, model }
  return out
}

const secretsOf = (s: AccountSession): AccountSecrets => ({ accessToken: s.accessToken, accessTokenExpiresAt: s.accessTokenExpiresAt, msRefreshToken: s.msRefreshToken })

/** Turn an `@amethyst/auth` error into an RPC error with a clear message and structured details. */
function mapAuthError(e: unknown): unknown {
  if (!(e instanceof AuthError)) return e
  const { name: _n, message: _m, code: _c, ...details } = e.toJSON()
  const message = e.code === 'EMSA_APP_NOT_APPROVED' ? APP_NOT_APPROVED : e.message
  return new AppError(e.code, message, details as Record<string, unknown>, { cause: e })
}

export class AccountManager {
  readonly #d: AccountManagerDeps
  readonly #auth: AuthApi
  readonly #secrets: SecretStore
  readonly #doc: JsonDocument<AccountsDoc>
  readonly #now: () => number
  readonly #refreshing = new Map<string, Promise<AccountRow>>()
  #login: AbortController | undefined

  constructor(deps: AccountManagerDeps) {
    this.#d = deps
    this.#auth = { ...defaultAuth, ...deps.auth }
    this.#now = deps.now ?? Date.now
    this.#secrets = new SecretStore(deps.layout.secrets, deps.host)
    this.#doc = new JsonDocument<AccountsDoc>(deps.layout.accounts, {
      version: 1,
      parse: (raw) => {
        const accounts: StoredAccount[] = []
        for (const r of Array.isArray(raw.accounts) ? raw.accounts : []) {
          const a = parseStoredAccount(r)
          if (a && !accounts.some((x) => x.id === a.id)) accounts.push(a)
        }
        const sel = readString(raw.selectedId)
        return { selectedId: sel && accounts.some((a) => a.id === sel) ? sel : (accounts[0]?.id ?? null), accounts }
      },
      defaults: () => ({ selectedId: null, accounts: [] }),
      serialize: (d) => d as unknown as Record<string, unknown>,
    })
  }

  async load(): Promise<void> {
    const r = await this.#doc.load()
    if (r.corruptPath) log.warn(`accounts.json was unreadable; kept as ${r.corruptPath} (${r.outcome})`)
  }

  get secrets(): SecretStore {
    return this.#secrets
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  status(): AccountsStatus {
    return {
      microsoft: this.#d.msaClientId ? { available: true } : { available: false, reason: 'no-client-id' },
      offlineAllowed: this.#d.settings.value.general.developerMode || this.#doc.value.accounts.some((a) => a.kind === 'microsoft'),
    }
  }

  #row(a: StoredAccount): AccountRow {
    const textures = currentTextures(a)
    const active = a.capes.find((c) => c.state === 'ACTIVE')
    const skin =
      a.kind === 'offline'
        ? a.localSkin
          ? { url: assetUrl(`skins/${a.localSkin.file}`), model: a.localSkin.model }
          : null
        : textures.SKIN
          ? { url: textures.SKIN.url, model: textures.SKIN.metadata?.model === 'slim' ? ('slim' as const) : ('classic' as const) }
          : null
    return {
      id: a.id,
      kind: a.kind,
      name: a.username,
      uuid: a.uuid,
      selected: this.#doc.value.selectedId === a.id,
      status: a.kind === 'offline' ? 'ok' : a.invalidated ? 'needs-sign-in' : a.accessTokenExpiresAt <= this.#now() ? 'expired' : 'ok',
      avatarUrl: a.kind === 'microsoft' && a.avatar?.startsWith('https://') ? a.avatar : null,
      skin,
      cape: a.kind === 'microsoft' && active ? { id: active.id, url: active.url } : null,
    }
  }

  #detail(a: StoredAccount): AccountDetail {
    return {
      ...this.#row(a),
      skins: a.kind === 'microsoft' ? a.skins.map((s) => ({ id: s.id, url: s.url, model: s.variant === 'SLIM' ? 'slim' : 'classic', active: s.state === 'ACTIVE' })) : [],
      capes: a.kind === 'microsoft' ? a.capes.map((c) => ({ id: c.id, url: c.url, alias: c.alias ?? null, active: c.state === 'ACTIVE' })) : [],
      loginHint: a.kind === 'microsoft' ? (a.loginHint ?? null) : null,
    }
  }

  list(): AccountRow[] {
    const rows = this.#doc.value.accounts.map((a) => this.#row(a))
    return rows.toSorted((a, b) => Number(b.selected) - Number(a.selected))
  }

  get(id: string): AccountDetail {
    return this.#detail(this.#record(id))
  }

  #record(id: string): StoredAccount {
    const a = this.#doc.value.accounts.find((x) => x.id === id)
    if (!a) throw notFound('Account')
    return a
  }

  /** Persist and announce account changes. */
  async #save(next: AccountsDoc, changed: { ids?: string[]; removed?: string[] }): Promise<void> {
    await this.#doc.set(next)
    this.#d.emit('accounts:changed', { ids: changed.ids ?? [], removed: changed.removed ?? [], selectedId: next.selectedId })
  }

  async #upsert(record: StoredAccount, select: boolean): Promise<void> {
    const doc = this.#doc.value
    const accounts = doc.accounts.some((a) => a.id === record.id) ? doc.accounts.map((a) => (a.id === record.id ? record : a)) : [...doc.accounts, record]
    await this.#save({ accounts, selectedId: select ? record.id : (doc.selectedId ?? record.id) }, { ids: [record.id] })
  }

  // -------------------------------------------------------------------------------------------
  // Microsoft sign-in
  // -------------------------------------------------------------------------------------------

  #clientId(): string {
    if (!this.#d.msaClientId) throw new AppError('EUNAVAILABLE', 'Microsoft sign-in is not available in this build (no client id was configured)')
    return this.#d.msaClientId
  }

  async loginMicrosoft(options: { method?: MicrosoftLoginMethod; accountId?: string } = {}): Promise<AccountRow> {
    const clientId = this.#clientId()
    const method = options.method ?? 'window'
    if (!['window', 'browser', 'device-code'].includes(method)) throw invalid('Unknown sign-in method')
    let expected: StoredAccount | undefined
    if (options.accountId !== undefined) {
      expected = this.#record(options.accountId)
      if (expected.kind !== 'microsoft') throw invalid('Only Microsoft accounts can sign in again')
    }
    // One interactive sign-in at a time: a new one replaces the previous.
    this.#login?.abort(new AuthError('ECANCELLED', 'Replaced by a new sign-in', { reason: 'USER_CANCELLED' }))
    const controller = new AbortController()
    this.#login = controller
    const signal = controller.signal
    try {
      const tokens = await this.#tokens(clientId, method, expected, signal)
      this.#d.emit('accounts:login', { stage: 'signing-in' })
      const session = await this.#auth.loginMicrosoft({ tokens, signal, ...(expected ? { expectedId: expected.id } : {}), onWarning: (w) => log.warn(`sign-in warning: ${w.code} ${w.message}`) })
      if (expected?.kind === 'microsoft' && expected.loginHint && !session.loginHint) session.loginHint = expected.loginHint
      await this.#storeSession(session)
      this.#d.emit('accounts:login', { stage: 'done', accountId: session.id })
      return this.#row(this.#record(session.id))
    } catch (e) {
      const mapped = mapAuthError(e)
      this.#d.emit('accounts:login', { stage: 'failed', code: errorCode(mapped) ?? 'EFAILED', message: mapped instanceof Error ? mapped.message : String(mapped) })
      throw mapped
    } finally {
      if (this.#login === controller) this.#login = undefined
    }
  }

  async #tokens(clientId: string, method: MicrosoftLoginMethod, expected: StoredAccount | undefined, signal: AbortSignal): Promise<MsTokens> {
    const loginHint = expected?.kind === 'microsoft' ? expected.loginHint : undefined
    if (method === 'device-code') {
      const device = await this.#auth.startDeviceCode({ clientId, signal })
      this.#d.emit('accounts:login', { stage: 'device-code', userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: device.expiresAt })
      this.#d.host.openExternal(device.verificationUri).catch(() => {})
      return this.#auth.pollDeviceCode({ clientId, device, signal })
    }
    const server = await this.#auth.startLoopbackServer({ signal })
    try {
      const req = this.#auth.createAuthorizationRequest({ clientId, redirectUri: server.redirectUri, ...(loginHint ? { loginHint } : {}) })
      let code: string
      if (method === 'browser') {
        this.#d.emit('accounts:login', { stage: 'browser', url: req.url })
        await this.#d.host.openExternal(req.url)
        code = (await server.waitForCode(req.state)).code
      } else {
        this.#d.emit('accounts:login', { stage: 'window' })
        const onAbort = () => {
          this.#d.host.closeAuthWindow().catch(() => {})
        }
        signal.addEventListener('abort', onAbort, { once: true })
        let finalUrl: string
        try {
          finalUrl = await this.#d.host.openAuthWindow(req.url, req.redirectUri)
        } catch (e) {
          if (signal.aborted || errorCode(e) === 'ECANCELLED') throw new AuthError('EMSA_CANCELLED', 'Sign-in was cancelled', { reason: 'USER_CANCELLED' })
          throw e
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
        const parsed = this.#auth.parseAuthorizationResponse(finalUrl, { redirectUri: req.redirectUri, state: req.state })
        if (!parsed) throw new AuthError('EMSA_NO_CODE', 'The sign-in window closed without an answer')
        code = parsed.code
      }
      return await this.#auth.exchangeCode({ clientId, code, codeVerifier: req.codeVerifier, redirectUri: req.redirectUri, signal })
    } finally {
      await server.close()
    }
  }

  async cancelLogin(): Promise<void> {
    this.#login?.abort(new AuthError('ECANCELLED', 'Cancelled', { reason: 'USER_CANCELLED' }))
    this.#login = undefined
    await this.#d.host.closeAuthWindow().catch(() => {})
  }

  /** Secrets first, then the public record (so a published account always has its tokens). */
  async #storeSession(session: AccountSession): Promise<void> {
    await this.#secrets.put(session.id, { accessToken: session.accessToken, accessTokenExpiresAt: session.accessTokenExpiresAt, msRefreshToken: session.msRefreshToken })
    const previous = this.#doc.value.accounts.find((a) => a.id === session.id)
    const record: StoredAccount = { ...toPublicAccount(session) }
    if (previous?.kind === 'microsoft' && previous.loginHint && !('loginHint' in record)) (record as { loginHint?: string }).loginHint = previous.loginHint
    await this.#upsert(record, true)
  }

  // -------------------------------------------------------------------------------------------
  // Offline, removal, selection
  // -------------------------------------------------------------------------------------------

  async addOffline(name: string, uuid?: string): Promise<AccountRow> {
    if (!this.status().offlineAllowed) throw new AppError('EOFFLINE_NOT_ALLOWED', 'Add a Microsoft account that owns Minecraft before adding offline players')
    let session
    try {
      session = createOfflineSession(String(name ?? ''), uuid === undefined ? {} : { uuid })
    } catch (e) {
      throw mapAuthError(e)
    }
    const existing = this.#doc.value.accounts.find((a) => a.id === session.id)
    await this.#upsert(existing ?? { ...toPublicAccount(session) }, true)
    return this.#row(this.#record(session.id))
  }

  async remove(id: string): Promise<void> {
    const a = this.#record(id)
    this.#refreshing.delete(id)
    await this.#secrets.delete(id)
    if (a.kind === 'offline' && a.localSkin) await rm(path.join(this.#d.layout.skins, a.localSkin.file), { force: true })
    const accounts = this.#doc.value.accounts.filter((x) => x.id !== id)
    const selectedId = this.#doc.value.selectedId === id ? (accounts[0]?.id ?? null) : this.#doc.value.selectedId
    await this.#save({ accounts, selectedId }, { removed: [id] })
  }

  async select(id: string): Promise<void> {
    this.#record(id)
    if (this.#doc.value.selectedId === id) return
    await this.#save({ ...this.#doc.value, selectedId: id }, { ids: [id] })
  }

  // -------------------------------------------------------------------------------------------
  // Refresh and tokens
  // -------------------------------------------------------------------------------------------

  /** The full session (with secrets). Unreadable credentials mark the account and reject with `ESIGN_IN_REQUIRED`. */
  async #session(a: StoredAccount): Promise<Session> {
    if (a.kind === 'offline') {
      return { ...a, kind: 'offline', accessToken: createHash('sha1').update(`${a.uuid}:${this.#now()}`).digest('hex').slice(0, 32), accessTokenExpiresAt: Number.MAX_SAFE_INTEGER }
    }
    const read = await this.#secrets.get(a.id)
    if (!read.ok || !read.secrets.msRefreshToken) {
      await this.#markInvalid(a.id)
      throw new AppError('ESIGN_IN_REQUIRED', `Sign in to ${a.username} again`, { reauth: true, accountId: a.id, reason: read.ok ? 'missing' : read.reason })
    }
    return { ...a, kind: 'microsoft', accessToken: read.secrets.accessToken, accessTokenExpiresAt: read.secrets.accessTokenExpiresAt, msRefreshToken: read.secrets.msRefreshToken }
  }

  async #markInvalid(id: string): Promise<void> {
    const a = this.#doc.value.accounts.find((x) => x.id === id)
    if (!a || a.invalidated) return
    await this.#upsert({ ...a, invalidated: true }, false)
  }

  /** Silent refresh, single-flight per account. */
  refresh(id: string, options: { force?: boolean } = {}): Promise<AccountRow> {
    const inflight = this.#refreshing.get(id)
    if (inflight) return inflight
    const p = this.#refreshNow(id, options.force === true).finally(() => {
      if (this.#refreshing.get(id) === p) this.#refreshing.delete(id)
    })
    this.#refreshing.set(id, p)
    return p
  }

  async #refreshNow(id: string, force: boolean): Promise<AccountRow> {
    const a = this.#record(id)
    if (a.kind === 'offline') return this.#row(a)
    const clientId = this.#clientId()
    const session = (await this.#session(a)) as AccountSession
    if (!force && !a.invalidated && !needsRefresh(session, this.#now())) return this.#row(a)
    try {
      const next = await this.#auth.refreshMicrosoft(session, {
        clientId,
        onRefreshTokenRotated: async (token) => {
          // The old refresh token may already be dead: persist the new one before anything else can fail.
          await this.#secrets.put(id, { ...secretsOf(session), msRefreshToken: token })
        },
      })
      if (!this.#doc.value.accounts.some((x) => x.id === id)) throw new AppError('ECANCELLED', 'The account was removed')
      if (next.uuid.replaceAll('-', '').toLowerCase() !== a.uuid.replaceAll('-', '').toLowerCase()) {
        await this.#markInvalid(id)
        throw new AppError('EACCOUNT_MISMATCH', 'The refreshed credentials belong to a different Minecraft profile; sign in again', { reauth: true })
      }
      await this.#secrets.put(id, secretsOf(next))
      const record: StoredAccount = { ...toPublicAccount(next) }
      if (a.loginHint && !('loginHint' in record)) (record as { loginHint?: string }).loginHint = a.loginHint
      await this.#upsert(record, false)
      return this.#row(this.#record(id))
    } catch (e) {
      if (e instanceof AuthError) {
        if (e.rotatedRefreshToken) await this.#secrets.put(id, { ...secretsOf(session), msRefreshToken: e.rotatedRefreshToken }).catch(() => {})
        // Definitive failures need a sign-in; transient ones (network, 5xx, 429) keep everything as is.
        if (e.reauth) await this.#markInvalid(id)
      }
      throw mapAuthError(e)
    }
  }

  /**
   * The session to launch with (for the launch service): refreshed silently when stale. Never
   * opens a window. Rejects with `ESIGN_IN_REQUIRED` when the user has to sign in again.
   */
  async sessionForLaunch(id: string): Promise<Session> {
    const a = this.#record(id)
    if (a.kind === 'microsoft') await this.refresh(id)
    return this.#session(this.#record(id))
  }

  /** A fresh Minecraft token, refreshing once more if the services reject it. */
  async #withToken<T>(id: string, fn: (token: string) => Promise<T>): Promise<T> {
    await this.refresh(id)
    let session = (await this.#session(this.#record(id))) as AccountSession
    try {
      return await fn(session.accessToken)
    } catch (e) {
      if (!(e instanceof AuthError) || e.code !== 'EMC_UNAUTHORIZED') throw mapAuthError(e)
      await this.refresh(id, { force: true })
      session = (await this.#session(this.#record(id))) as AccountSession
      try {
        return await fn(session.accessToken)
      } catch (again) {
        if (again instanceof AuthError && again.code === 'EMC_UNAUTHORIZED') await this.#markInvalid(id)
        throw mapAuthError(again)
      }
    }
  }

  async #applyProfile(id: string, profile: MinecraftProfile): Promise<AccountDetail> {
    const a = this.#record(id)
    await this.#upsert({ ...a, skins: profile.skins, capes: profile.capes, username: profile.name }, false)
    return this.get(id)
  }

  // -------------------------------------------------------------------------------------------
  // Skins and capes
  // -------------------------------------------------------------------------------------------

  async #skinBytes(source: SkinSource): Promise<Uint8Array> {
    if (!isRecord(source)) throw invalid('Unknown skin source')
    let bytes: Uint8Array
    if ('path' in source && typeof source.path === 'string') {
      if (!path.isAbsolute(source.path)) throw invalid('An absolute file path is required')
      const st = await stat(source.path)
      if (st.size > MAX_SKIN_BYTES) throw new AppError('ESKIN_TOO_LARGE', 'Skin file is too large')
      bytes = await readFile(source.path)
    } else if ('dataUrl' in source && typeof source.dataUrl === 'string') {
      bytes = decodeDataUrl(source.dataUrl)
    } else if ('url' in source && typeof source.url === 'string') {
      if (!/^https:\/\//i.test(source.url)) throw invalid('Only https: skin URLs are allowed')
      if (!this.#d.fetchBytes) throw new AppError('EUNAVAILABLE', 'Downloading skins is not available')
      bytes = await this.#d.fetchBytes(source.url, { maxBytes: MAX_SKIN_BYTES })
    } else throw invalid('Unknown skin source')
    try {
      validateSkinPng(bytes)
    } catch (e) {
      throw mapAuthError(e)
    }
    return bytes
  }

  async setSkin(id: string, source: SkinSource, model: 'classic' | 'slim'): Promise<AccountDetail> {
    if (model !== 'classic' && model !== 'slim') throw invalid('model must be "classic" or "slim"')
    const a = this.#record(id)
    const png = await this.#skinBytes(source)
    if (a.kind === 'offline') {
      // Launcher-only: shown in the skin viewer, never sent to a server.
      await mkdir(this.#d.layout.skins, { recursive: true })
      const file = `${a.uuid}-${createHash('sha1').update(png).digest('hex').slice(0, 12)}.png`
      await writeFile(path.join(this.#d.layout.skins, file), png)
      if (a.localSkin && a.localSkin.file !== file) await rm(path.join(this.#d.layout.skins, a.localSkin.file), { force: true })
      await this.#upsert({ ...a, localSkin: { file, model } }, false)
      return this.get(id)
    }
    const profile = await this.#withToken(id, (accessToken) => this.#auth.uploadSkin({ accessToken, png, variant: model }))
    return this.#applyProfile(id, profile)
  }

  async resetSkin(id: string): Promise<AccountDetail> {
    const a = this.#record(id)
    if (a.kind === 'offline') {
      if (a.localSkin) await rm(path.join(this.#d.layout.skins, a.localSkin.file), { force: true })
      const { localSkin: _drop, ...rest } = a
      await this.#upsert(rest as StoredAccount, false)
      return this.get(id)
    }
    return this.#applyProfile(id, await this.#withToken(id, (token) => this.#auth.resetSkin(token)))
  }

  async setCape(id: string, capeId: string | null): Promise<AccountDetail> {
    const a = this.#record(id)
    if (a.kind !== 'microsoft') throw invalid('Offline accounts have no capes')
    if (capeId !== null && !a.capes.some((c) => c.id === capeId)) throw new AppError('ECAPE_INVALID', 'This account does not own that cape')
    const profile = await this.#withToken(id, (token) => (capeId === null ? this.#auth.hideCape(token) : this.#auth.showCape(token, capeId)))
    return this.#applyProfile(id, profile)
  }

  async flush(): Promise<void> {
    await this.#doc.flush()
  }
}

/** The RPC facade. */
export function accountsService(manager: AccountManager): AccountsService {
  return {
    getStatus: async () => manager.status(),
    list: async () => manager.list(),
    get: async (id) => manager.get(id),
    loginMicrosoft: (options) => manager.loginMicrosoft(options),
    cancelLogin: () => manager.cancelLogin(),
    addOffline: (name, uuid) => manager.addOffline(name, uuid),
    remove: (id) => manager.remove(id),
    select: (id) => manager.select(id),
    refresh: (id, options) => manager.refresh(id, options),
    setSkin: (id, source, model) => manager.setSkin(id, source, model),
    resetSkin: (id) => manager.resetSkin(id),
    setCape: (id, capeId) => manager.setCape(id, capeId),
  }
}
