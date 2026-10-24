/**
 * Microsoft and offline Minecraft accounts: OAuth (auth code + PKCE, loopback, device code,
 * refresh rotation), the Xbox Live → XSTS → Minecraft services chain, profiles, skins and capes.
 *
 * Pure Node: no Electron imports and no persistence. The app stores sessions (encrypted with
 * `safeStorage`) and only ever sends {@link toPublicAccount} results to the renderer.
 *
 * Typical interactive login:
 *
 * ```ts
 * const server = await startLoopbackServer({ signal })
 * const req = createAuthorizationRequest({ clientId, redirectUri: server.redirectUri })
 * openInBrowser(req.url)
 * const { code } = await server.waitForCode(req.state)
 * const tokens = await exchangeCode({ clientId, code, codeVerifier: req.codeVerifier, redirectUri: req.redirectUri })
 * const session = await loginMicrosoft({ tokens })
 * ```
 */

export {
  AuthError,
  isAuthError,
  type AuthErrorCode,
  type AuthErrorDetails,
  type AuthErrorReason,
  type AuthErrorType,
  type SerializedAuthError,
} from './errors'
export { DEFAULT_RETRY, DEFAULT_TIMEOUT_MS, parseRetryAfter, type HttpOptions, type RetryPolicy } from './http'
export { decodeJwtPayload } from './jwt'
export {
  DEFAULT_SCOPES,
  MSA_AUTHORITY,
  createAuthorizationRequest,
  exchangeCode,
  matchesRedirectUri,
  parseAuthorizationResponse,
  pkceChallenge,
  pollDeviceCode,
  refreshMsToken,
  startDeviceCode,
  type AuthorizationRequest,
  type AuthorizationRequestOptions,
  type DeviceCode,
  type ExchangeCodeOptions,
  type MsTokens,
  type PollDeviceCodeOptions,
  type RefreshMsTokenOptions,
  type StartDeviceCodeOptions,
} from './oauth'
export { DEFAULT_LOOPBACK_TIMEOUT_MS, startLoopbackServer, type LoopbackOptions, type LoopbackServer } from './loopback'
export {
  MINECRAFT_RELYING_PARTY,
  XBOX_LIVE_RELYING_PARTY,
  XSTS_ERRORS,
  authenticateXbl,
  authorizeXsts,
  getXboxProfile,
  xstsError,
  type XboxProfile,
  type XboxToken,
} from './xbox'
export {
  currentTextures,
  getEntitlements,
  getProfile,
  hideCape,
  loginWithXbox,
  parseProfile,
  resetSkin,
  setSkinUrl,
  showCape,
  uploadSkin,
  type Cape,
  type CurrentTextures,
  type Entitlements,
  type MinecraftProfile,
  type MinecraftToken,
  type SetSkinUrlOptions,
  type Skin,
  type SkinModel,
  type SkinVariant,
  type TextureState,
  type UploadSkinOptions,
} from './minecraft'
export { MAX_SKIN_BYTES, isSkinSize, readPngDimensions, validateSkinPng } from './png'
export { createOfflineSession, normalizeUuid, offlineUuid, validateOfflineName, type OfflineSessionOptions } from './offline'
export {
  REFRESH_MARGIN_MS,
  joinSession,
  needsRefresh,
  parseSession,
  splitSession,
  toPublicAccount,
  type AccountSession,
  type OfflineSession,
  type PublicAccount,
  type Session,
  type SessionSecrets,
} from './session'
export {
  loginMicrosoft,
  refreshMicrosoft,
  type ChainOptions,
  type LoginMicrosoftOptions,
  type RefreshMicrosoftOptions,
} from './microsoft'
