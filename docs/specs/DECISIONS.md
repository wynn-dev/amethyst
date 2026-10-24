# Product decisions

This file is authoritative. Where another spec conflicts with it, this file wins.

## Platform and distribution
- macOS 13 Ventura or later, Apple Silicon (arm64) only. Bundle ID `dev.wynn.amethyst`.
- Signed with a Developer ID certificate and notarized. Every push to `main` replaces the rolling `nightly` GitHub release.
- In-app updates through electron-updater, from the nightly release. The updater downloads in the background and shows "Restart to Update".
- GPL-3.0-only. Clean-room implementation (see `docs/ARCHITECTURE.md`).
- English only: no i18n framework and no language switch.

## Kept scope
- Instances: create, edit, duplicate, delete (to the Trash), and import an existing folder.
- Installing vanilla, Forge, NeoForge, Fabric and Quilt.
- Launching, the game log, and the crash view.
- Mods, resource packs, shader packs and saves.
- Modrinth and CurseForge: browse, install, and update.
- Modpack import and export: `.mrpack` and CurseForge zips.
- Java: discovery, plus automatic download from the Mojang runtime manifest for arm64.
- Accounts: Microsoft and offline, with a 3D skin viewer and skin/cape changes.
- Settings.
- Themes: light/dark following the system, accent colour, background image or video, and blur.
- **New:** world backups. A manual "Back up world" action, an automatic backup before version or modpack changes, and restore.
- Telemetry with PostHog on the EU cloud (`eu.i.posthog.com`). It is opt-in on first run, with two toggles that are both OFF by default:
  - "Share usage data": usage events plus active users, counted with an anonymous install ID.
  - "Send crash reports": errors and crashes plus performance timings.
  - No session replay, client IP is discarded, and paths and usernames are scrubbed.
  - Everything can be changed later in Settings → Privacy.

## Dropped
- p2p and LAN multiplayer.
- i18n.
- Server hosting and server status ping.
- Discord RPC.
- Big Picture and gamepad mode.
- The AI agent.
- Bedrock.
- Modrinth publishing and project binding.
- Third-party auth: authlib-injector, ely.by, LittleSkin, and Yggdrasil servers.
- Download mirrors, such as BMCLAPI.
- Migration from XMCL or other launchers.
- XMCL account and services.
- FTB modpacks.
- OptiFine. No OptiFine install and no special handling. Users can still add an OptiFine jar to `mods/` by hand. The Discover view points to Sodium/Iris (Fabric/Quilt) and Embeddium/Oculus (Forge/NeoForge) instead.
- UI and theme extras:
  - the Home card grid and focus mode
  - the palette editor
  - particle and halo backgrounds
  - background music
  - custom fonts and custom CSS
  - the theme store
  - per-instance themes
  - theme export and import
- Mod-folder colours and shared folder rules.
- The network stats tab.

## Deferred (after v1)
- The world map viewer.
- The advancement viewer.
- Modrinth account collections. v1 has local Favourites only.

## Apple Silicon native runtime
- Every Minecraft version runs natively on arm64. Rosetta is never required.
- The native libraries are chosen **per launch, from the architecture of the selected JVM** (probe it), never from the launcher's own architecture.
- LWJGL 3:
  - Versions that already ship `natives-macos-arm64` (1.19 and later) are used as-is.
  - Older LWJGL 3 versions (Minecraft 1.13–1.18) are replaced with LWJGL 3.3.x macOS arm64 natives from Maven Central, matched by artifact family and version range.
  - The exception is GLFW for those versions. LWJGL 3.3.1's GLFW reports an error from `glfwSetWindowIcon` on macOS, and Minecraft before 1.19 treats that error as fatal. Amethyst therefore builds its own `libglfw.dylib` in CI (`natives/lwjgl3-glfw`): the same upstream GLFW source as LWJGL 3.3.1, with that call made a silent no-op. It is published and pinned the same way as the LWJGL 2 natives.
- LWJGL 2 (Minecraft 1.12.2 and older):
  - Amethyst **builds its own** arm64 natives (LWJGL 2.9.x, and jinput where needed) from public source in a CI workflow in this repo.
  - They are published on our own GitHub release (`natives-*` tag), with sha256 values pinned in the app.
  - No third-party native binaries are used.
- Other native libraries on arm64:
  - `java-objc-bridge` (the 1.12 narrator) is upgraded to the author's official 1.1 release from Maven Central, which already includes arm64. This counts as an upstream release, not a third-party rebuild.
  - `twitch-platform` natives (1.7.3–1.8.9) are dropped. They are proprietary, x86_64-only, and the Twitch service is defunct.
- Java runtimes:
  - Use Mojang's runtime manifest (`mac-os-arm64`) where Mojang ships a build.
  - Otherwise use **Azul Zulu** through the official Azul metadata API, verified with sha256. This covers Java 8, Java 16, and any component Mojang lacks for arm64.

## Content model
- Instances are **isolated**: each has its own saves, resource packs and shader packs, and there are no shared folders.
- Identical files are stored once in the content-addressed store and placed into instances with APFS clones or hard links.
- Every content tab has an "Add from another instance…" picker.

## CurseForge
- For files whose authors block third-party downloads, use the compliant flow:
  - Show a "Missing files" dialog with a link to each file's page.
  - Watch `~/Downloads` for the files and accept drag-and-drop.
  - **Never** guess CDN URLs.

## Credentials
- Credentials are supplied at build time through `AMETHYST_*` env vars (see `apps/desktop/.env.example`) and are available only in the main process:
  - `AMETHYST_MSA_CLIENT_ID`: the user's own Azure app, which needs Mojang approval.
  - `AMETHYST_CURSEFORGE_API_KEY`
  - `AMETHYST_POSTHOG_KEY`
- When a credential is missing, its feature degrades gracefully:
  - Microsoft login is shown as unavailable.
  - CurseForge is hidden.
  - Telemetry is a no-op.
