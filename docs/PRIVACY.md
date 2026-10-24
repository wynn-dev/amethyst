# Privacy

Amethyst can send anonymous usage data and crash reports to help us improve it. **Both are off
until you turn them on**, and you can change your mind at any time in Settings → Privacy.

This page lists everything Amethyst collects. It is the source for the "Learn more…" sheet in the
app. The code that enforces it is in [`packages/telemetry`](../packages/telemetry/src/events.ts).
Events outside that schema are rejected, so nothing that isn't listed here can be sent.

## The two choices

| Setting | Off by default | What it covers |
| --- | --- | --- |
| **Share usage data** | Yes | Which features are used, such as launches and installs, and active-user counts |
| **Send crash reports** | Yes | Errors and crashes in the launcher, plus performance timings |

- Until you turn a setting on, **nothing is sent and nothing is kept to send later.** Turning a
  setting on doesn't send anything from before.
- When you turn a setting off, it takes effect immediately. Anything still waiting to be sent is
  deleted.
- Crash reports cover the **launcher only**. Game logs and Minecraft crash reports are never sent.
- There is no session replay, no screenshots, no keystroke or mouse tracking, and no advertising
  identifiers.

## Where it goes

Data is sent to [PostHog](https://posthog.com) on its **EU cloud** (`eu.i.posthog.com`, hosted in
Frankfurt) over HTTPS.

- **Your IP address is not recorded.** Every event sets `$ip` to null, and location lookup
  (GeoIP) is turned off.
- **No profile is built about you.** Events are sent without person profiles
  (`$process_person_profile: false`).
- Builds made without a PostHog key (for example your own builds from source) send nothing at all.

## The anonymous install ID

Events are grouped by a random ID (a UUID) that Amethyst creates for this installation. It isn't
derived from your Mac, your Microsoft or Minecraft account, or anything else about you. It is never
linked to an account. It is stored in `~/Library/Application Support/Amethyst/telemetry.json`,
alongside your choices, and is only written once you make a choice. Deleting that file resets it.

## Sent with every event

| Property | Example | Why |
| --- | --- | --- |
| Install ID | `3f0c1d2e-…` | Count active installs (daily/monthly active users) without knowing who you are |
| `$app_version` | `0.1.0-nightly.42` | Tell which version a problem affects |
| `$os` / `$os_version` | `macOS` / `15.1` | Tell which macOS versions are in use |
| `arch` | `arm64` | Always Apple Silicon today; kept for completeness |
| `electron_version` | `45.0.0` | Tell which Electron version a problem affects |
| `$lib` / `$lib_version` | `posthog-node` / `5.57.1` | Added by the PostHog library |
| Time and event ID | | When the event happened, and an ID so it isn't counted twice |

## Usage events ("Share usage data")

| Event | Properties | When |
| --- | --- | --- |
| `app_opened` | none | Once each time Amethyst starts |
| `screen_viewed` | `screen`: the screen template, such as `/instances/$id/mods` (never a real instance name) | When you open a screen |
| `instance_created` | `loader` (vanilla, forge, neoforge, fabric or quilt), `mcVersion` (e.g. `1.21.1`) | When you create an instance |
| `install_completed` | `loader`, `mcVersion`, `durationMs`, `bytes` downloaded | When a Minecraft or loader install finishes |
| `launch_started` | none | When you press Play |
| `launch_exited` | `exitKind` (normal, crash or killed), `durationMs` played | When the game exits |
| `modpack_imported` | `source` (modrinth, curseforge or file) | When you import a modpack |
| `content_installed` | `source` (modrinth, curseforge or file), `kind` (mod, resourcepack, shaderpack, datapack or world) | When you install content |

Usage events never include instance names, world names, server addresses, mod or file names,
usernames, or chat.

## Crash reports and performance ("Send crash reports")

| Event | Properties | When |
| --- | --- | --- |
| `$exception` | Error type, message and stack trace (scrubbed, see below), whether it was handled, `$exception_level` (error or fatal), and `source` (main, runtime or renderer: which part of Amethyst failed) | When the launcher hits an error it didn't expect. At most 10 per minute. |
| `perf_startup` | `coldStartMs`, `firstPaintMs` | Time from opening Amethyst until it is usable |
| `perf_download` | `throughputBps`, `files` | Download speed and file count for an install |
| `perf_launch` | `clickToSpawnMs` | Time from pressing Play to the game process starting |

### Scrubbing

Before an error is sent, its message and stack trace are cleaned on your Mac:

- Your home folder (`/Users/<you>`) becomes `~`, and your macOS username becomes `<user>`.
- File and folder names inside instances, worlds, mods, resource packs, shader packs, data packs,
  screenshots, schematics, backups, logs, crash reports, Desktop, Documents and Downloads become
  `<redacted>`. Only the file extension is kept, e.g. `mods/<redacted>.jar`.
- Email addresses, UUIDs (including Minecraft player IDs), access and refresh tokens, JWTs, API
  keys, long hexadecimal strings, passwords in URLs, and IPv4/IPv6 addresses are removed.
- Player names you are signed in with are removed.
- Paths to Amethyst's own code are shortened to `app:///…`, so where you installed the app isn't
  sent either.
- No source code or file contents are attached.

## What is never collected

- Your Microsoft or Minecraft account, gamertag, player name, UUID, skins or tokens
- Instance, world, server, mod, resource pack or file names
- Game logs, Minecraft crash reports, chat, or anything typed in the game
- Your IP address or location
- Anything from other apps on your Mac

## Updates

The auto-updater downloads `latest-mac.yml` and the update itself from GitHub
(`github.com/wynn-dev/amethyst/releases`). This is not telemetry: GitHub sees an ordinary download
request, as for any file you download from GitHub, and Amethyst sends nothing else with it. Updates
are checked 10 seconds after launch and then every 4 hours while the app is running.
