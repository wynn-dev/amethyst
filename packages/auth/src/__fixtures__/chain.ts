/**
 * Fixture responses for the Microsoft → Xbox → Minecraft chain, shaped like the real services
 * (see minecraft.wiki "Microsoft authentication"). Tokens are fake.
 */

import { createFakeFetch, json, type FakeFetch, type Handler } from './fake-fetch'

export const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
export const DEVICE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode'
export const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate'
export const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
export const XBOX_PROFILE_URL = 'https://profile.xboxlive.com/users/xuid(2535412345678901)/profile/settings'
export const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
export const MC_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/mcstore'
export const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
/** An unsigned JWT-shaped string with the given payload. */
export const fakeJwt = (payload: Record<string, unknown>) => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.c2ln`

export const MC_ACCESS_TOKEN = fakeJwt({ xuid: '2535499999999999', sub: 'mc-account-1' })

export const msTokenResponse = (refreshToken = 'ms-refresh-2') => ({
  token_type: 'Bearer',
  scope: 'XboxLive.signin offline_access',
  expires_in: 3600,
  access_token: 'ms-access',
  refresh_token: refreshToken,
})

export const xblResponse = {
  IssueInstant: '2026-10-24T10:00:00.0000000Z',
  NotAfter: '2026-11-07T10:00:00.0000000Z',
  Token: 'xbl-token',
  DisplayClaims: { xui: [{ uhs: 'uhs-1234' }] },
}

export const xstsMinecraftResponse = {
  IssueInstant: '2026-10-24T10:00:00.0000000Z',
  NotAfter: '2026-10-25T02:00:00.0000000Z',
  Token: 'xsts-mc-token',
  DisplayClaims: { xui: [{ uhs: 'uhs-1234' }] },
}

export const xstsXboxResponse = {
  IssueInstant: '2026-10-24T10:00:00.0000000Z',
  NotAfter: '2026-10-25T02:00:00.0000000Z',
  Token: 'xsts-xbox-token',
  DisplayClaims: { xui: [{ uhs: 'uhs-1234', xid: '2535412345678901', gtg: 'Tester' }] },
}

export const xboxProfileResponse = {
  profileUsers: [
    {
      id: '2535412345678901',
      hostId: '2535412345678901',
      settings: [
        { id: 'GameDisplayPicRaw', value: 'https://images-eds-ssl.xboxlive.com/image?url=abc' },
        { id: 'Gamertag', value: 'Tester' },
      ],
      isSponsoredUser: false,
    },
  ],
}

export const mcLoginResponse = {
  username: 'mc-account-1',
  roles: [],
  access_token: MC_ACCESS_TOKEN,
  token_type: 'Bearer',
  expires_in: 86400,
}

export const entitlementsResponse = {
  items: [
    { name: 'product_minecraft', signature: 'jwt' },
    { name: 'game_minecraft', signature: 'jwt' },
  ],
  signature: 'jwt',
  keyId: '1',
}

export const emptyEntitlementsResponse = { items: [], signature: 'jwt', keyId: '1' }

export const profileResponse = {
  id: '069a79f444e94726a5befca90e38aaf5',
  name: 'Notch',
  skins: [
    { id: 'skin-1', state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/abc', variant: 'CLASSIC', alias: 'STEVE' },
    { id: 'skin-0', state: 'INACTIVE', url: 'http://textures.minecraft.net/texture/old', variant: 'SLIM' },
  ],
  capes: [{ id: 'cape-1', state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/cape', alias: 'Migrator' }],
}

export const profileNotFound = {
  path: '/minecraft/profile',
  errorType: 'NOT_FOUND',
  error: 'NOT_FOUND',
  errorMessage: 'The server has not found anything matching the request URI',
  developerMessage: 'The server has not found anything matching the request URI',
}

export const xstsErrorBody = (xErr: number) => ({
  Identity: '0',
  XErr: xErr,
  Message: '',
  Redirect: 'https://start.ui.xboxlive.com/AddChildToFamily',
})

/** Route XSTS requests by relying party. */
export function xstsRoute(minecraft: Handler, xbox: Handler = json(xstsXboxResponse)): Handler {
  return (call) => {
    const body = JSON.parse(call.text ?? '{}') as { RelyingParty?: string }
    const handler = body.RelyingParty === 'http://xboxlive.com' ? xbox : minecraft
    return typeof handler === 'function' ? handler(call) : handler
  }
}

/** A fake fetch wired for a fully successful chain. Override individual routes as needed. */
export function chainFetch(overrides: Record<string, Handler | Handler[]> = {}): FakeFetch {
  return createFakeFetch({
    [`POST ${TOKEN_URL}`]: json(msTokenResponse()),
    [`POST ${XBL_URL}`]: json(xblResponse),
    [`POST ${XSTS_URL}`]: xstsRoute(json(xstsMinecraftResponse)),
    [`GET ${XBOX_PROFILE_URL}`]: json(xboxProfileResponse),
    [`POST ${MC_LOGIN_URL}`]: json(mcLoginResponse),
    [`GET ${MC_ENTITLEMENTS_URL}`]: json(entitlementsResponse),
    [`GET ${MC_PROFILE_URL}`]: json(profileResponse),
    ...overrides,
  })
}
