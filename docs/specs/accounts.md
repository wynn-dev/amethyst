# Accounts: Microsoft login, offline accounts, skins and capes

Status: behavioural specification for Amethyst (clean-room). Target: macOS 13+ on Apple Silicon, Electron main process plus React renderer.

This document says what the account subsystem must do, which public endpoints it talks to, what it stores, and how it fails. It describes what the reference launcher (XMCL) observably does where that helps, and marks where Amethyst should do something different.

Public references:

- Microsoft identity platform, OAuth 2.0 authorization code flow: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- Device authorization grant (device code): https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code
- Redirect URI rules, including the localhost/loopback port exception: https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
- Refresh tokens: https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
- PKCE (RFC 7636): https://datatracker.ietf.org/doc/html/rfc7636
- Community documentation of the Xbox Live, XSTS and Minecraft chain: https://minecraft.wiki/w/Microsoft_authentication (formerly https://wiki.vg/Microsoft_Authentication_Scheme)
- Mojang/Minecraft services API: https://minecraft.wiki/w/Mojang_API
- XSTS error enumeration (GDK): https://learn.microsoft.com/en-us/gaming/gdk/_content/gc/reference/system/xstsruntimes/enums/xsts_token_error_code
- Electron `safeStorage`: https://www.electronjs.org/docs/latest/api/safe-storage

---

## 1. Concepts and data model

### 1.1 Account vs game profile

- An **account** (a "user") is one login identity: one Microsoft account, or the local offline account holder.
- An account owns one or more **game profiles**: a Minecraft UUID, a player name, and textures. A Microsoft account that owns Java Edition has exactly one profile today, but the model allows several. Offline accounts can hold many profiles, one per offline name.
- The launcher keeps a **selected account**. Each account also keeps a **selected profile**. Launching uses the selected profile of the selected account.

### 1.2 Account record (persisted, non-secret)

Each account record holds these fields:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable local identifier. Microsoft: derived from the Minecraft services `username` field returned by `login_with_xbox`. Note that this is NOT the profile UUID. Offline: a fixed sentinel id (see §6). |
| `kind` / authority | enum `microsoft` \| `offline` | Which account system owns the record. |
| `username` | string | Microsoft: the Microsoft account sign-in name (email or phone) as MSAL/OAuth reports it, used as a login hint. Offline: a fixed placeholder. |
| `invalidated` | boolean | True when the last refresh failed in a way that needs user attention, for example a re-login. The UI shows the account as "expired". |
| `expiresAt` | epoch ms | When the Minecraft access token expires. Use `-1` or `0` for "unknown/expired", and effectively infinite for offline. |
| `profiles` | map uuid → GameProfile | See below. |
| `selectedProfile` | uuid string | Key into `profiles`. Empty if the account owns no profile. |
| `avatar` | string (URL), optional | Xbox gamer picture URL, if it could be fetched. |
| `xuid` | string, optional | Amethyst addition. Xbox user id, passed to the game at launch (see §5.4). |

GameProfile fields:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Minecraft UUID. The services API returns it without dashes. Keep it as returned and normalise it when comparing. |
| `name` | string | Player name. |
| `skins[]` | `{id, state: ACTIVE\|INACTIVE, url, variant: CLASSIC\|SLIM, alias?}` | As returned by Minecraft services. |
| `capes[]` | `{id, state: ACTIVE\|INACTIVE, url, alias?}` | As returned by Minecraft services. |
| `textures` | `{SKIN: {url, metadata?: {model: 'slim'\|'default'}}, CAPE?: {url}}` | Normalised "current" textures, used by the viewer and by offline accounts. |
| `uploadable` | `('skin'\|'cape')[]` | What the UI may change. Both values apply to Microsoft and offline accounts. |

### 1.3 Persistence layout (Amethyst)

All paths are under the app data dir (`~/Library/Application Support/Amethyst/`):

- `accounts.json` holds the account records above. **It never holds tokens.** Write it atomically (temp file + rename) and debounce writes by about 1 s after state changes. Flush on quit.
- `accounts.json.bak` is the previous non-empty version. On load, if the primary file is missing or malformed and the backup is valid, recover from the backup. Never let an accidental empty write replace a non-empty file: an empty account list may only be persisted when the user explicitly removed the last account. Record that intent (for example a sidecar marker containing a hash of the empty file) so a crash after the deliberate removal does not resurrect the account from the backup. XMCL added this guard because users reported losing every account after crashes or startup races.
- Secrets go in the secret store (§4).

The selected account id is UI state. XMCL kept it in renderer `localStorage`. Amethyst should persist it in `accounts.json` (`selectedAccountId`) so the main process knows it, for example for "launch last instance" from the Dock menu.

Startup behaviour:

1. Load the records. Drop any record that fails schema validation, one record at a time, so one malformed record does not wipe the others.
2. Publish the account list to the renderer **immediately**. A stalled network refresh must never hide the persisted accounts.
3. In the background, refresh every Microsoft account silently with validation (§3). Failures only mark the account `invalidated`. They never delete it.
4. If the selected account id no longer exists, select the first account.

Optional import: if `~/Library/Application Support/minecraft/launcher_profiles.json` contains an `authenticationDatabase`, XMCL imported those entries as Microsoft accounts with an expired token. This is low value for Amethyst and can be skipped. Do NOT write into the vanilla launcher's files. XMCL creates an empty `launcher_profiles.json` in the game data dir because some Forge installers require that file to exist, and that belongs in the install spec.

---

## 2. Microsoft login: end-to-end flow

### 2.1 Azure application registration (Amethyst-specific)

Amethyst **must register its own Azure (Entra) application**. It must not reuse XMCL's client ID or any other launcher's.

- Supported account types: **Personal Microsoft accounts only**. The authority is `https://login.microsoftonline.com/consumers/`.
- Platform: **Mobile and desktop applications**, which makes it a public client with no client secret.
- Redirect URIs: `http://localhost`. Microsoft ignores the port for `localhost` loopback redirects on native clients (see the reply-url docs), so the launcher can pick any free port at runtime. Optionally also register the custom scheme `amethyst://auth` (§2.3, option C).
- Enable **"Allow public client flows"**. This is required for the device code flow.
- **Mojang allow-listing.** Mojang must approve new app IDs before they can call `api.minecraftservices.com/authentication/login_with_xbox`. Until then that endpoint returns HTTP 403 with an "Invalid app registration" message pointing at `https://aka.ms/AppRegInfo`. Apply via Mojang's review form (linked from that page; historically `https://aka.ms/mce-reviewappid`) early, because approval can take weeks. Development is blocked on this. Keep the client ID in build config, not hard-coded in several places.

### 2.2 Scopes

Request `XboxLive.signin offline_access`. `offline_access` is required to receive a refresh token. XMCL also requested `XboxLive.offline_access` and `User.Read`. `User.Read` was only for its own cloud account service, which is dropped, so Amethyst should not request it.

### 2.3 Step 1: obtain a Microsoft (MSA) access token

Amethyst offers two interactive methods. Silent refresh (§3) comes first whenever a cached account exists.

**A. Authorization code + PKCE in an embedded window (default).**

1. Generate a PKCE `code_verifier` (43–128 chars, high entropy) and an S256 `code_challenge`, plus a random `state`.
2. Start, or reuse, a loopback HTTP listener bound to **the loopback interfaces only** (`127.0.0.1`, plus `[::1]` on the same port, since `localhost` may resolve to either; Microsoft ignores the port only for `localhost` redirect URIs and does not support `[::1]`), on a free port. It handles the fallback in option B. Build `redirect_uri = http://localhost:<port>/auth`.
3. Open `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=…&response_type=code&redirect_uri=…&scope=XboxLive.signin%20offline_access&code_challenge=…&code_challenge_method=S256&state=…&prompt=select_account`. Add `login_hint=<email>` when re-authenticating a known account.
4. Open this URL in a dedicated modal `BrowserWindow`:
   - Size about 560×720, minimum 420×600, parented to the main window, hidden until `ready-to-show`.
   - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
   - A **dedicated persistent session partition**, so Microsoft cookies are isolated from the app and survive restarts. That makes "pick an existing account" easy.
5. Watch `will-redirect` and `will-navigate`. Top-level navigations may only go to Microsoft/Live/Xbox sign-in hosts over https (`apps/desktop/src/main/auth-navigation.ts`); other https links open in the browser, everything else is cancelled, and popups never open a new window. When the target URL matches the redirect URI, cancel the navigation and parse it. Treat `localhost`, `127.0.0.1` and `[::1]` as equivalent when the scheme, port and path match, because Microsoft can rewrite the loopback host. Then:
   - `error` param → fail with `error_description || error` (see §2.8).
   - Mismatched `state` → fail.
   - `code` param → resolve with the code.
   - Neither → fail with "no code".
6. Popups from the identity pages (`window.open`): if the target is https, or has the redirect origin, load it in the same window and deny the popup. Ignore malformed URLs.
7. Closing the window means "user cancelled". A renderer crash, or a failed initial load, are distinct errors.
8. Exchange the code: POST `https://login.microsoftonline.com/consumers/oauth2/v2.0/token` (form-encoded) with `client_id`, `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, `scope`. The response contains `access_token`, `refresh_token`, `expires_in` and `id_token` (if `openid` was requested).
9. If an existing account was being re-authenticated and the result belongs to a different Microsoft account, fail with "account mismatch". Compare the `oid`/`sub` from the id token, or the home account id. Never silently overwrite account A's tokens with account B's.

**B. System browser + loopback (fallback).** Some users cannot complete login in the embedded window, for example when they need a passkey or Windows Hello-style platform authenticators. For them, open the same authorize URL in the default browser with `shell.openExternal`. The loopback listener receives `GET /auth?code=…&state=…`, replies with a small "You can close this tab" HTML page, and resolves the pending login. While waiting, show the URL in the login form ("open manually" link) and a Cancel button. Abort the wait on cancel or after a timeout (about 10 minutes).

**C. Custom protocol `amethyst://auth` (optional).** XMCL registered its own protocol and accepted `xmcl://launcher/auth?code=…`. On macOS this arrives through `app.on('open-url')` and needs `CFBundleURLTypes` in Info.plist. It is only needed if a hosted page relays the code. Loopback is simpler, so prefer it. If you implement C, also validate `state`.

**D. Device code (user-selectable checkbox).**

1. POST `https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode` with `client_id` and `scope`. The response contains `device_code`, `user_code`, `verification_uri` (`https://www.microsoft.com/link`), `expires_in` and `interval`.
2. Show `user_code` in the password field area, read-only and copyable. Show `verification_uri` as a link, and open it in the system browser automatically.
3. Poll the token endpoint with `grant_type=urn:ietf:params:oauth:grant-type:device_code` every `interval` seconds:
   - `authorization_pending` → keep polling.
   - `slow_down` → add 5 s to the interval.
   - `authorization_declined`, `expired_token`, `bad_verification_code` → fail.
   - Cancel stops polling.
4. On success, handle the token response exactly like the auth code result.

XMCL used `@azure/msal-node` (PublicClientApplication with a cache plugin) instead of hand-rolled OAuth. Either approach is acceptable:

- MSAL gives you account lookup and silent refresh. You must persist its serialized cache blob in the secret store (§4).
- Hand-rolled is about 200 lines. You store the refresh token yourself and get full control.

Recommendation: hand-rolled, because it has fewer native dependencies and no broker. The Windows WAM broker, which XMCL used, is irrelevant on macOS.

### 2.4 Step 2: Xbox Live user token (XBL)

POST `https://user.auth.xboxlive.com/user/authenticate`, with headers `Content-Type: application/json`, `Accept: application/json` and `x-xbl-contract-version: 1`:

```json
{
  "Properties": {
    "AuthMethod": "RPS",
    "SiteName": "user.auth.xboxlive.com",
    "RpsTicket": "d=<MSA access token>"
  },
  "RelyingParty": "http://auth.xboxlive.com",
  "TokenType": "JWT"
}
```

The `d=` prefix is required for tokens obtained through the v2.0 endpoint with an Azure app. The response contains `Token`, `NotAfter`, and `DisplayClaims.xui[0].uhs` (the user hash). A non-200 response is an error. Surface the status and body.

### 2.5 Step 3: XSTS token(s)

POST `https://xsts.auth.xboxlive.com/xsts/authorize`:

```json
{
  "Properties": { "SandboxId": "RETAIL", "UserTokens": ["<XBL Token>"] },
  "RelyingParty": "rp://api.minecraftservices.com/",
  "TokenType": "JWT"
}
```

- This request is **mandatory**, with relying party `rp://api.minecraftservices.com/`. Read `Token` and `DisplayClaims.xui[0].uhs`. If `DisplayClaims.xui` is missing, treat it as a "bad XSTS response" error.
- A second request with relying party `http://xboxlive.com` is **optional**. Its only use is to fetch the gamertag and avatar from `https://profile.xboxlive.com/users/xuid(<xid>)/profile/settings?settings=PublicGamerpic,Gamertag` (headers `x-xbl-contract-version: 2`, `Authorization: XBL3.0 x=<uhs>;<xsts token>`). Its `xui[0].xid` is the XUID. **Failure here must never block login.** Some accounts that legitimately own Minecraft (region or age restrictions, missing full Xbox profile) can authorize the Minecraft relying party but fail this one. XMCL learned this the hard way: users said "it works in the official launcher", and the official launcher never asks for this relying party. If it fails, log a warning, show no avatar, and take the XUID from the Minecraft token (§5.4).
- Run the avatar fetch in parallel with Step 4.

On a 401 from XSTS, the body is JSON with `Identity`, `XErr` (a number), `Message` and `Redirect`. Map `XErr` as follows (from the GDK enum and community docs):

| XErr | Meaning | UI message and action |
|---|---|---|
| 2148916227 | Account banned or enforcement action | "This account is banned from Xbox services." |
| 2148916229 | Account restricted: guardian has not allowed online play | "A parent or guardian must allow online play in Microsoft Family settings." Link: https://account.microsoft.com/family/ |
| 2148916233 | No Xbox profile (account never used Xbox) | "Sign in once at xbox.com to create an Xbox profile, then try again." Link: https://account.xbox.com/ |
| 2148916234 | Xbox terms of service not accepted | "Accept the Xbox terms by signing in at xbox.com." |
| 2148916235 | Xbox Live not available in the user's country/region | "Xbox Live is not available in your region." |
| 2148916236, 2148916237 | Adult (age) verification required (South Korea) | "Age verification required." Link to the `Redirect` if it is an https URL. |
| 2148916238 | Child account (under 18) not in a Family group | "An adult must add this account to a Microsoft Family group." Link: https://account.microsoft.com/family/ |
| other | Unknown | "Xbox sign-in failed (code N)". Always show the raw code so users can search for it. |

Important: the `Redirect` field for some codes is a **console-only deep link** (for example `https://start.ui.xboxlive.com/AddChildToFamily`) that does not resolve in a browser. Do not show it as-is. Map the code to the browser pages above.

XMCL also fetched an Xbox **device token** before XSTS. It used `https://device.auth.xboxlive.com/device/authenticate`, a persisted P-256 key, and a signed proof-of-possession request, and passed the result as `Properties.DeviceToken`. This is **not required** for Minecraft Java. Amethyst should skip it in v1. If it is ever added, it must be best-effort: any failure falls back to plain XSTS.

### 2.6 Step 4: Minecraft services login

POST `https://api.minecraftservices.com/authentication/login_with_xbox`:

```json
{ "identityToken": "XBL3.0 x=<uhs>;<XSTS token for rp://api.minecraftservices.com/>" }
```

The response is `{ "username": "<services account id, not the player UUID>", "access_token": "<JWT>", "token_type": "Bearer", "expires_in": 86400, "roles": [] }`.

- Set `expiresAt = now + expires_in*1000`.
- **Retry policy.** Retry 408, 425, 429, 500, 502, 503 and 504 up to 4 attempts, with exponential backoff (base 500 ms, cap 30 s). Honour `Retry-After`, which can be seconds or an HTTP-date, and wait at least as long as it says. Cancel the response body before sleeping. Abort promptly when the login is cancelled. Apply the same wrapper to the XBL and XSTS calls.
- If retries are exhausted, raise a structured error: `{status, body (truncated to about 512 chars), retryAfterMs, retryable}`. UI messages:
  - 429 → "Too many requests, try again in N seconds".
  - 5xx → "Minecraft services error (HTTP N)".
  - 403 with JSON `details.reason == "ACCOUNT_SUSPENDED"` → "This account is suspended".
  - 403 "Invalid app registration" → developer-facing message about Mojang app approval (§2.1).
  - Other statuses → "HTTP N".

### 2.7 Step 5: entitlements and profile

1. GET `https://api.minecraftservices.com/entitlements/mcstore` with `Authorization: Bearer <mc token>`. The response is `{ items: [{name: "product_minecraft" | "game_minecraft" | …, signature}], signature, keyId }`.
   - XMCL calls this **for logging only** and does not block on an empty list.
   - That is the right call: Game Pass accounts and recently purchased accounts can show empty or late entitlements. The profile lookup is the authoritative check.
   - A failure here is a warning, not an error.
   - There is also a newer `entitlements/license?requestId=<uuid>` variant. Either is fine.
2. GET `https://api.minecraftservices.com/minecraft/profile` with a Bearer token.
   - 200 returns `{ id, name, skins: [...], capes: [...] }` (shapes in §1.2).
   - 404 with `{"error":"NOT_FOUND", …}` means **this account has no Java profile**. Either the game is not owned, or it was bought but no name was chosen yet. Show the dedicated message: "This Microsoft account does not have a Minecraft: Java Edition profile. If you just bought the game, set your player name at minecraft.net first." Optionally offer in-app profile creation (§7.5).
   - 401 → token rejected.
   - A non-JSON content type → error carrying the raw text.
3. Build the account record:
   - one game profile;
   - `textures.SKIN` from the `ACTIVE` skin, or the first skin if none is active, with model `slim` iff `variant == SLIM`;
   - `textures.CAPE` from the `ACTIVE` cape, if any.
4. Write the Minecraft access token, and the refresh material, to the secret store **before** the record is published.
5. Select the new account. Add the email to the login-history list (offered as autocomplete in the username field).

### 2.8 Error taxonomy surfaced to the UI

Every failure becomes one structured error with a `type`. The renderer maps types to friendly text. **Classify structurally, by the `type` field. Do not classify by error class name**: class names do not survive IPC or minification, and XMCL leaked raw internal messages because of this.

| type | When |
|---|---|
| `msaTokenFailed` (reason `USER_CANCELLED` \| `NETWORK` \| undefined) | Step 1 failed. OAuth errors `access_denied`, `user_cancelled` or a closed window map to USER_CANCELLED. Network failures map to NETWORK. |
| `xboxTokenFailed` (reason from the XErr table, `xErr`, `xErrMessage`) | Steps 2–3. |
| `badXsts` | XSTS response without claims. |
| `minecraftLoginFailed` (`status`, `body`, `retryable`, `retryAfterMs`, reason `ACCOUNT_SUSPENDED`?) | Step 4. |
| `noJavaProfile` | Profile 404. |
| `profileFetchFailed` (`errorType`, `errorMessage`, `developerMessage`) | Other profile errors. |
| `tokenExpired` | Refresh concluded the user must log in again. |
| `aborted` | User pressed Cancel. Show nothing, or "cancelled". |

Some failures are **user-state, not bugs**: known XErr codes, NOT_FOUND, cancellations, network errors, 408 and 429, and the OAuth codes `access_denied`, `consent_required`, `interaction_required`, `login_required`, `invalid_request` and `server_error`. Log them at warn level, and never as crash or telemetry exceptions.

On any Microsoft login error, the form also shows a help box linking to a troubleshooting page. Amethyst should host its own page.

### 2.9 Login form behaviour (renderer)

- Account type selector: Microsoft (default), and Offline (see §6.3 for when Offline is offered).
- **Microsoft**:
  - A username/email combobox with history.
  - The password field is permanently read-only, because there is no password grant.
  - A "Use device code" checkbox. When checked, the password field shows the user code after the request starts.
  - The primary button reads "Log in". While a login is running it becomes "Cancel" and aborts the login.
  - A "Create account" link to https://signup.live.com/signup.
- **Email requirement**: XMCL required a syntactically valid email before Microsoft login could start, because it was used as `login_hint` and as the key to find the cached account. Amethyst should make the email **optional**. If it is empty, use `prompt=select_account` with no hint, and key the account by the Microsoft account id returned by the token response. XMCL's email regex also rejected valid addresses (see Pitfalls).
- **Streamer mode** (a UI setting) masks the username field as a password field and hides email addresses elsewhere.
- Pressing Enter in any field submits. Typing clears the previous error.
- Errors are tied to the account type that produced them. Switching the selector hides an unrelated error.

---

## 3. Refresh, validation and token lifetime

### 3.1 Tokens involved

| Token | Lifetime | Stored? |
|---|---|---|
| MSA access token | about 1 h | No. Used immediately. |
| MSA refresh token | Long-lived and sliding (personal accounts are typically valid up to 90 days of inactivity). **It rotates: every refresh returns a new one, and you must persist the new one.** | Yes, secret store |
| XBL / XSTS tokens | Hours (see `NotAfter`) | No. Re-derive them on refresh. |
| Minecraft access token | 24 h (`expires_in` 86400) | Yes, secret store (needed for launch) |

### 3.2 When to refresh

A Microsoft account is considered stale, and is re-derived through the whole chain using the refresh token, if any of these hold:

- `force` was requested;
- `expiresAt` is unknown or in the past. Use a safety margin of about 5 minutes. XMCL had no margin;
- the record is `invalidated`;
- `validate` was requested and the token fails online validation.

Online validation is POST `https://sessionserver.mojang.com/session/minecraft/join` with `{accessToken, selectedProfile: <profile id>, serverId: <random>}`. A 204 means valid; anything else means invalid. A cheaper alternative is GET `/minecraft/profile` (200 means valid, 401 means invalid).

Refresh triggers:

- **App startup**: every Microsoft account, silent, with validation, in parallel, without blocking the UI.
- **Before every launch**: the launching account. XMCL validated only when "fast launch" was off.
- **On demand**, before skin, cape or name operations, if the token is stale.

### 3.3 Silent vs interactive

- **Silent refresh**: use the stored refresh token (`grant_type=refresh_token`, same scope), or MSAL `acquireTokenSilent`. A silent refresh never opens a window.
- If silent refresh fails with `invalid_grant` or `interaction_required`, that is a definitive failure. Set `invalidated = true`. For an explicitly user-initiated refresh, the UI may then offer "Log in again", which starts §2.3 with `login_hint`.
- **Transient failures** (network, 5xx, 429) must NOT wipe stored secrets. Set `invalidated = true` (or keep the current state), keep the old token, and retry on the next trigger. XMCL fixed a bug where a transient startup failure wiped a still-valid token and forced a re-login.
- The refresh must not be interactive unless the user asked for it. In XMCL a non-silent refresh path could pop the Microsoft window during launch. Amethyst should only open a login window from an explicit user action, for example a "Session expired – Log in" dialog.

### 3.4 Concurrency

- Refreshes of the same account are **deduplicated**: concurrent callers share one in-flight promise, keyed by account id. Startup refresh, pre-launch refresh and "get token for API call" all go through the same gate. Otherwise two concurrent token rotations race, one refresh token is invalidated, and the account breaks.
- Only one interactive login runs at a time. A second login request either cancels the first or is rejected.
- Login, refresh and skin upload each have an abortable controller, exposed as `abortLogin` and `abortRefresh`.
- If an account is removed while its refresh is in flight, discard the result. Do not re-add the account.

### 3.5 Launch with an expired or invalid account

If the selected account is invalidated or expired at launch and refresh fails, show a dialog with "Log in" and "Play anyway". "Play anyway" launches with the stale token; the game then runs in a degraded state (multiplayer will fail).

If no account exists at all, XMCL launched a demo or offline fallback with the name "Steve". Amethyst should require an account, or explicitly offer demo mode (`--demo`).

---

## 4. Secret storage

### 4.1 What XMCL does

- It has a secret store abstraction with `get(service, account)` and `put(service, account, value)`, where an empty value means delete.
- The Electron implementation writes one file per secret into `<appData>/secret/`, named after a sanitized `service@account`.
- Each file starts with a 4-byte marker:
  - one marker means "safeStorage-encrypted payload follows";
  - another means "plaintext UTF-8 follows". This is used when encryption was unavailable or unhealthy at write time;
  - legacy files with no marker are decrypted with safeStorage.
- Before trusting encryption it runs a **round-trip probe**: encrypt a constant, decrypt it, compare. `isEncryptionAvailable()` alone can lie on broken Linux keyrings. If encryption fails mid-run, it marks itself unhealthy and writes plaintext rather than a corrupt blob.
- A remote feature flag could force plaintext.
- Stored items:
  - the MSAL token cache (one blob: accounts, refresh tokens, id tokens);
  - each account's Minecraft access token, keyed by authority + account id. On read, a Microsoft token that is not JWT-shaped (three base64url segments) is treated as missing;
  - the Xbox device key/token;
  - an in-memory cache in front of the store.

### 4.2 Amethyst recommendation (macOS only)

Use Electron **`safeStorage`**. On macOS it is backed by a per-app encryption key held in the **login Keychain** (item "<App Name> Safe Storage"), so ciphertext on disk is useless without the user's Keychain.

- Store exactly one encrypted blob per Microsoft account in `<appData>/secrets/<accountId>.bin`. Contents, as JSON before encryption: `{ msaRefreshToken, mcAccessToken, mcExpiresAt, xuid, msaHomeAccountId }`. Alternatively, store one blob with the whole MSAL cache if MSAL is used.
- Write atomically (temp + rename). Use file mode 0600.
- `safeStorage` is only usable after `app.whenReady()`. All secret access happens in the main process. **Tokens never cross IPC to the renderer.** The renderer gets account records only. The launch spec builds the game command line in the main process.
- No plaintext fallback on macOS. If `isEncryptionAvailable()` is false, which should not happen on macOS, refuse to persist: keep tokens in memory for the session and warn the user.
- Code signing matters. The Keychain item's ACL is bound to the app's signing identity. Unsigned or ad-hoc dev builds will trigger a Keychain access prompt, and changing the Team ID later invalidates access to previously stored secrets. That forces a one-time re-login, so handle "decrypt failed" as "re-login needed", never as a crash. Use a separate app name or secret directory for dev builds so dev and prod do not fight over the item.
- Alternative: store items directly as Keychain generic passwords with a native module (keytar is archived/unmaintained). `safeStorage` is preferred because it has no native dependency.
- **On account removal, delete the secrets** (account blob, and MSAL cache entries for that account) and clear the login window's session cookies for that account, if feasible. XMCL left them behind (see Pitfalls).

---

## 5. Using the account at launch (interface to the launch spec)

### 5.1 Inputs to the launch builder

The account subsystem provides, for the selected account and profile:

- player name;
- profile UUID;
- access token (from the secret store, after the pre-launch refresh);
- user type;
- XUID (optional);
- client id.

### 5.2 Values per account kind

| Placeholder | Microsoft | Offline |
|---|---|---|
| `${auth_player_name}` | profile name | offline name |
| `${auth_uuid}` | profile id (undashed, as returned) | offline UUID (§6.1) |
| `${auth_access_token}` | Minecraft access token | random 32-hex string (any non-empty value) |
| `${user_type}` | `msa` | `legacy` |
| `${auth_xuid}` | XUID (see §5.4), or `0`/empty | `0`/empty |
| `${clientid}` | stable per-install random id (base64 or UUID) | same |

### 5.3 Logging

When logging the launch options, mask the access token (replace it with `***`). XMCL did this. Also mask it in any "copy launch command" feature.

### 5.4 XUID

XMCL did not pass the XUID. Amethyst should, because the vanilla launcher does and newer versions use it for telemetry and chat reporting. Get it from the optional `http://xboxlive.com` XSTS response (`xid`). If that call failed, decode the Minecraft access token JWT payload and read its `xuid` claim (no signature check needed). Persist it in the account's secret blob, or in the record; it is not sensitive.

---

## 6. Offline accounts

### 6.1 Offline UUID derivation

This matches what a vanilla server in `online-mode=false` assigns.

1. Input string: `"OfflinePlayer:" + name`, encoded as UTF-8. The name is case-sensitive: "Steve" and "steve" produce different UUIDs.
2. Compute MD5 of the input, giving 16 bytes.
3. Set the version nibble to 3: `byte[6] = (byte[6] & 0x0F) | 0x30`.
4. Set the RFC 4122 variant: `byte[8] = (byte[8] & 0x3F) | 0x80`.
5. Format as a lowercase hex UUID with dashes (8-4-4-4-12).

This is the Java `UUID.nameUUIDFromBytes` behaviour, a name-based v3 UUID **without a namespace**. It is not the RFC namespace-v3 variant, so do not use a generic `uuidv3(name, namespace)` helper.

Test vectors:

| name | UUID |
|---|---|
| `Steve` | `5627dd98-e6be-3c21-b8a8-e92344183641` |
| `Notch` | `b50ad385-829d-3141-a216-7e7d7539ba7f` |
| `jeb_` | `a762f560-4fce-3236-812a-b80efff0b62b` |

### 6.2 Offline account model

- XMCL keeps **one** offline account record with a fixed id (a sentinel such as `OFFLINE`).
- Each offline login **adds a profile** to it, keyed by the profile UUID. Logging in again with an existing name re-selects that profile.
- The offline record's `expiresAt` is effectively infinite, and refresh is a no-op.
- The access token is a random UUID without dashes, stored like other tokens. Amethyst may generate it at launch instead.
- Name validation:
  - required;
  - 3–16 characters;
  - `[A-Za-z0-9_]` only;
  - Cyrillic gets a dedicated message.

  Vanilla accepts other names in some contexts, but servers and mods often break on them, so keep the restriction.
- Optional custom UUID field. If provided, it must be a valid UUID, with or without dashes, and is used **instead of** the derived one. Store it as the profile key. Do not re-derive it later (see Pitfalls).
- Removing a single offline profile is supported (remove the profile from the record). Removing the offline account removes all offline profiles.

### 6.3 Policy for offering offline login

XMCL shows the Offline account type only when any of these is true:

- a Microsoft account already exists in the launcher;
- developer mode is on;
- the system locale is not in a list of strict regions (most of Europe, North America, Australia, Japan, Korea).

Amethyst should adopt the simpler and stricter rule: **offline accounts are available only after at least one Microsoft account that owns Java Edition has been added**, plus a developer-mode override. This keeps the launcher on the right side of Mojang's guidance for third-party launchers.

### 6.4 Offline skins

- An offline profile can hold a local skin and cape:
  - choose a PNG from disk or a URL;
  - local files are copied into launcher storage so the URL stays valid;
  - the slim flag is stored in the texture metadata.
- These textures show **only in the launcher's viewer**. XMCL delivered them in-game through authlib-injector and a local Yggdrasil server. Both are out of scope, so Amethyst offline skins are cosmetic in the launcher only. Say so in the UI.

---

## 7. Skins and capes (Microsoft accounts)

All endpoints require `Authorization: Bearer <Minecraft access token>`. Refresh first if the token is stale. On 401, refresh once and retry once. If that also fails, mark the account `invalidated`.

### 7.1 Read

`GET https://api.minecraftservices.com/minecraft/profile` returns `skins[]` and `capes[]`.

- The current skin is the one with `state: ACTIVE`; if none is active, use the first.
- The model is `SLIM` (Alex, 3-px arms) or `CLASSIC` (Steve, 4-px arms).
- The current cape is the `ACTIVE` cape. There may be none.

### 7.2 Upload a skin

`POST https://api.minecraftservices.com/minecraft/profile/skins`, in one of two forms:

- **multipart/form-data** with `variant` = `classic` | `slim` and `file` = the PNG (`image/png`, any filename). Use this for local files.
- **JSON** `{"variant": "classic"|"slim", "url": "https://…"}`. Mojang fetches the URL. Use this only for public http(s) URLs. XMCL always downloaded the image and used multipart, which is the safer default.

Behaviour:

- The response is the updated profile. Replace the profile's `skins`, `capes` and `textures` with it.
- On error (a body with `error` or `errorMessage`):
  - if the message mentions an invalid or banned image → "Minecraft rejected this image (invalid or not allowed)";
  - otherwise → "Upload rejected: <message>".
- Validate before upload:
  - it is a PNG (check the magic bytes, not the file extension);
  - dimensions are 64×64, or legacy 64×32;
  - size is under about 24 KB. Mojang enforces a limit; reject anything over a few hundred KB client-side.
- Skin sources the uploader must accept:
  - a local file path;
  - a `data:` URL (base64);
  - an http(s) URL (download it first);
  - an internal launcher media URL pointing to a local file.

### 7.3 Reset skin

`DELETE https://api.minecraftservices.com/minecraft/profile/skins/active` reverts to the default skin. Afterwards, re-fetch the profile, because the default skin URL is assigned server-side.

### 7.4 Capes

- Equip: `PUT https://api.minecraftservices.com/minecraft/profile/capes/active` with `{"capeId": "<id>"}`. The id must be one of the profile's owned `capes[]`. You cannot upload new capes; a Microsoft account can only pick from capes it owns. 400 → "invalid cape". The response is the updated profile.
- Hide: `DELETE https://api.minecraftservices.com/minecraft/profile/capes/active`.

### 7.5 Name management (optional for v1)

- `GET /minecraft/profile/namechange` → `{changedAt, createdAt, nameChangeAllowed}`.
- `GET /minecraft/profile/name/<name>/available` → `{status: AVAILABLE | DUPLICATE | NOT_ALLOWED}`.
- `PUT /minecraft/profile/name/<name>` changes the name. Errors: 400 invalid, 403 not allowed (cooldown), 429.
- For an account with no profile yet, `POST /minecraft/profile` with `{"profileName": "<name>"}` creates it.

### 7.6 Looking up another player's skin (for the skin library)

1. Name → UUID: `GET https://api.mojang.com/users/profiles/minecraft/<name>` → `{id, name}`. 404 or 204 means no such player. The newer equivalent is `GET https://api.minecraftservices.com/minecraft/profile/lookup/name/<name>`.
2. UUID → textures: `GET https://sessionserver.mojang.com/session/minecraft/profile/<uuid>?unsigned=true`. The response has `properties[]`; find `name == "textures"`, base64-decode its `value`, and parse the JSON. Take `textures.SKIN.url`. It is slim iff `textures.SKIN.metadata.model == "slim"`.
3. Rate limits apply (roughly 600 requests per 10 min per IP for Mojang APIs). Cache results for a few minutes.

### 7.7 Exporting a skin

"Save skin as…" writes the currently displayed skin to a user-chosen `.png`. Use the system save dialog with default name `<player>.png` and a PNG filter. The source can be a `data:` URL, a local file, a launcher media URL, or a remote URL; download remote URLs.

---

## 8. Skin library ("closet")

This is a launcher-local collection of skins the user can preview and equip.

### 8.1 Storage

- Directory: `<appData>/closet/`.
- Each skin is stored as `<uuid>.png`.
- The index is `index.json` (atomic writes): `{ skins: [{id, name, url, source?, slim, dateAdded}], equipped: { "<accountId>:<profileId>": skinId } }`. `url` points at the local copy. `source` is where it came from: a path, URL or player-lookup URL.
- When loading, any entry whose `url` is still remote is downloaded into the closet and the index is rewritten, so the library works offline.

### 8.2 Operations

All operations are serialized by one mutex. If a step fails, roll back the in-memory state and remove the copied file.

- **Add.** Inputs: name (trimmed; default "Custom Skin") and a source. The source can be:
  - a local file: choose with the PNG-filtered open dialog, or drag and drop. Only `.png` is accepted. The name defaults to the file's base name;
  - an http(s) URL: the name defaults to "Web Skin";
  - a player name plus account type: looked up via §7.6. The name defaults to `<player>@mojang`, and the slim flag is taken from the lookup.

  Validate the content as PNG by magic bytes, then copy or download it into the closet. Insert new skins at the top. The editor preview auto-detects the model when the user has not set one.
- **Update.** Rename or toggle slim.
- **Remove.** Delete the entry, clear any `equipped` entries that point at it, and delete the PNG **only if it lives inside the closet directory** (path-containment check).
- **Equip.** Upload the skin to the account (Microsoft: §7.2; offline: set the local texture), then record `equipped[accountKey] = id`.
- **Auto-capture.** When the library opens for an account whose current skin is not in the library (matched by `url` or `source`), add the current skin automatically under the name `<player>@mojang`. A skin that is already present counts as "equipped".
- **Search.** Case-insensitive substring match on the name.

---

## 9. 3D skin viewer (UI behaviour)

Implementation: a WebGL canvas using the open-source `skinview3d` library (MIT), wrapped in a React component.

### 9.1 Component inputs

| Input | Default | Meaning |
|---|---|---|
| skin URL | none | Falls back to the bundled default Steve texture when empty. |
| cape URL | none | |
| slim | undefined | `undefined` means auto-detect the model from the texture. |
| player name | "Steve" | Rendered as a name tag above the head. |
| width × height | 210×400 (300 high in the account card) | |
| animation | `idle` | `none` \| `idle` \| `walking` \| `running` |
| paused | false | |

### 9.2 Camera and controls

- Field of view about 45°, initial zoom about 0.5.
- Mouse-drag rotates the model (orbit). Zoom and pan are disabled or limited.

### 9.3 Animation rules in the account card

- `running` while the pointer hovers the viewer.
- Otherwise `walking` if this profile is the account's selected profile, else `idle`.

### 9.4 Loading rules

- Loads are serialized: a new skin load waits for the previous one to settle.
- Results from a viewer instance that has since been disposed are ignored.
- After a successful load with auto-detect, report the detected model (`default` or `slim`) to the parent. The parent sets its slim toggle from it once and then turns auto-detect off.
- If loading fails with a bad-dimensions error, notify "Invalid skin image (must be 64×64 or 64×32)". Other load errors notify a generic failure.
- Cape changes are chained after any in-flight cape load. Clearing the cape removes it from the model.
- Renaming updates the name tag live. Clearing the name removes the tag.
- `paused` stops the render loop without disposing the viewer.
- Rendering is paused when:
  - the viewer is off-screen (IntersectionObserver);
  - the window is hidden or minimized;
  - a game is running.

  Dispose the WebGL context on unmount. Too many live contexts crash Chromium.

### 9.5 Editing interactions (account card)

- **Hover controls**: a Classic/Slim segmented toggle (top-right). It is shown only if the skin is uploadable. Changing it disables auto-detect.
- **Speed-dial actions**:
  - open skin library;
  - import skin from URL (a small dialog);
  - load from file (PNG dialog);
  - save/export the current skin.
- **Drop**: dropping a PNG file on the canvas stages it as the new skin and enables auto-detect.
- **Staged changes**: a skin URL, slim flag or cape that differs from the account's current active ones counts as "modified". When something is modified, two buttons appear:
  - **Save** uploads only the parts that changed: the skin and/or the cape, where a cape cleared to "none" means hide;
  - **Reset** reverts to the current values.

  Both are disabled while an upload is in flight. Success shows a toast; failure shows a localized error. Switching to another profile resets the staged state.
- **Cape row** below the viewer:
  - a horizontal, wheel-scrollable radio group;
  - the first item is "No cape", followed by each owned cape as a 2D cape thumbnail with a tooltip showing the alias or id;
  - the selected item is highlighted;
  - keyboard-accessible with arrow keys, and Enter or Space to select;
  - selecting stages the change.

---

## 10. Account management UI

- An **account switcher** (in the top bar or sidebar) lists the accounts with:
  - avatar, which is the Xbox gamerpic or a head rendered from the skin;
  - player name;
  - account type;
  - an "expired" badge when the account is invalidated or expired.

  Selecting an account switches immediately. If an account has several profiles, a sub-list selects the profile.
- **Actions per account**:
  - Refresh (forced);
  - Log in again (for invalidated accounts);
  - Remove (with confirmation);
  - Copy UUID.
- **Add account** opens the login form (§2.9).
- **Events from main to renderer**:
  - login started, succeeded or failed;
  - device code issued (user code + URI);
  - authorize URL issued (for "open manually");
  - refresh succeeded;
  - account list changed.

Out of scope here: Minecraft Friends (the friends list, requests and privacy toggles at `api.minecraftservices.com/friends` and `/player/attributes`), which XMCL shows on the profile page. It is not in the dropped list, but it is not needed for v1 and is not specified.

---

## Pitfalls / bugs observed in the original

1. **Hard dependency on the email field.** Microsoft login could not start without a valid-looking email. The email regex rejected `+` in the local part (`user+mc@gmail.com`) and TLDs longer than 6 characters (for example `.photography`), which locked those users out. Make the hint optional and do not validate email syntax.
2. **The refresh "older than 14 days" condition was dead code.** It computed days since expiry, which is always covered by the "expired" check. There was also no expiry safety margin, so a token could expire seconds after a launch check passed. Use a margin of about 5 minutes.
3. **The skin upload error path read the response body twice** on 401 (JSON-parsed it, then tried to parse it again), producing a confusing "body already used" error instead of "unauthorized".
4. **Removing an account did not delete its secrets.** The per-account token file and the MSAL cache entries stayed in the secret directory, and the login webview's persistent cookies stayed signed in. Delete them all on removal.
5. **Offline custom UUIDs were silently discarded.** The login used the custom UUID as the profile key but always set the selected profile to the derived UUID. At next startup a migration step re-keyed every offline profile to the derived UUID, so the selected profile pointed at nothing and the custom UUID was lost.
6. **All offline profiles shared one account record**, so per-profile token and refresh semantics were muddled. One "remove" deleted every offline name. Amethyst may keep the shared record but must support per-profile removal.
7. **The loopback server bound to all interfaces.** XMCL's local HTTP server (used for the OAuth callback and other launcher endpoints) listened with no host argument, so it was reachable from the LAN. Bind to 127.0.0.1 only.
8. **No `state` / PKCE check visible in the redirect handler.** The handler accepted any `code` that arrived on the callback path. Always validate `state`; PKCE binds the code to the requesting instance.
9. **A non-silent refresh could open an interactive window during launch.** The pre-launch refresh did not pass a silent flag, so a cache miss could pop up a Microsoft window mid-launch.
10. **Classification by error class name broke across IPC.** XMCL compensated by matching message strings (for example the profile-fetch message). Use structured `type` fields end to end.
11. **The Xbox-avatar relying party used to block login.** It was later made optional. Keep it optional from day one.
12. **XSTS `Redirect` deep links are console-only.** Showing them sent users to dead pages. Map XErr codes to browser URLs.
13. **Entitlement check is advisory only.** XMCL ignores an empty entitlement list (correct for Game Pass). Do not gate on it. The profile 404 is the real "doesn't own" signal, and it needs its own message, because new buyers who have not chosen a name hit it too.
14. **Startup races could persist an empty account list** over a good one, which wiped every account. Hence the backup and explicit-empty-intent design in §1.3.
15. **The Microsoft access token was treated as invalid if it was not JWT-shaped**, a guard against a corrupted secret that came back as garbage. Amethyst should instead treat a decryption or parse failure as "re-login needed", explicitly.
16. **The XUID was never passed to the game**, and the `clientid` placeholder was left to library defaults.
17. **Offline-mode availability depended on the OS locale**, which is unpredictable for users (for example a VPN or a changed region flips it). Use an explicit rule.
