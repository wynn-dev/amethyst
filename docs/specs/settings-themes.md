# Global settings and the theme system

Status: behavioural specification for Amethyst (clean-room). Target: macOS 13+ on Apple Silicon, Electron + React.

This document lists every global launcher setting in the reference launcher (XMCL), says which ones Amethyst keeps or drops, and specifies the appearance/theme system. Per-instance overrides of launch settings belong in `instances.md`. This file defines the global defaults those overrides fall back to.

---

## 1. Storage model

XMCL splits settings across three stores. Amethyst should keep the same split, but make it explicit:

| Store | Location (Amethyst) | Owner | Contents |
|---|---|---|---|
| **Launcher settings** | `<appData>/settings.json` | main process | Anything the main process needs: launch defaults, network, updates, window. |
| **Data root pointer** | `<appData>/root` (plain text: one absolute path) | main process | Where instances, versions, libraries and assets live (§2.1). |
| **Theme** | `<appData>/theme.json`, `<appData>/theme.css`, `<appData>/theme-media/` | main process (file IO), renderer (logic) | §4. |
| **UI preferences** | renderer persistent storage | renderer | View-only toggles (§3). |

`<appData>` = `~/Library/Application Support/Amethyst`.

### 1.1 Persistence rules for `settings.json`

- **Load.** Read the JSON and validate each field on its own. A missing or invalid field falls back to its default without discarding the other fields. A missing or corrupt file means all defaults. Never crash on a bad settings file.
- **Save.**
  - Any change marks the settings dirty. Writes are debounced to about 1 s and are atomic (temp + rename).
  - A write failure is logged and retried on the next change. It is never shown as a crash.
  - Flush pending writes on quit.
- **Runtime-only state.** Some fields live in the same live object but are **never persisted**:
  - `online` (network reachability);
  - `updateStatus` (`none` \| `pending` \| `ready`), `updateInfo` and update capability;
  - `diskFullError`;
  - `invalidDataRoot` (reason code, §2.1);
  - `databaseReady`;
  - `corruptedResourceCount`, a count of resource index rows healed at startup, used for a UI hint.

  Keep them in a separate runtime-state object, not in the persisted schema. XMCL mixed the two, and its in-memory defaults then diverged from its schema defaults (see Pitfalls).
- **Sync.** The renderer gets a live, read-only mirror. Mutations are IPC calls to the main process, one setter per field, validated there. Subscribers in the main process react to specific field changes. For example, a proxy change reconfigures the HTTP stack immediately, and a theme-source change updates `nativeTheme`.

### 1.2 Settings UI structure

The settings page has these sections. A settings search box filters across all of them by title and description.

1. **General**: data location, privacy, developer mode, streamer mode, quick-action shortcut, native replacement.
2. **Appearance**: the theme system (§4) and sidebar layout (§3.2).
3. **Global game settings**: launch defaults (§2.3).
4. **Network**: proxy, download concurrency (§2.4).
5. **Updates**: launcher updates (§2.5).
6. **Advanced**: reset, export and import settings (§2.7).
7. **About**: version, license (GPL-3.0), credits.

---

## 2. Launcher settings (kept)

Types: `bool`, `int`, `string`, `string[]`, `map<string,string>`.

### 2.1 Data root (General)

| Setting | Type / default | Effect |
|---|---|---|
| Data root | path. Default: chosen on first run; suggested `~/Library/Application Support/Amethyst/data` | Root folder for instances, versions, libraries, assets and the resource store. |

First run:

- If the `root` file does not exist, the app shows onboarding. Onboarding asks for the data root first, then appearance (light/dark/system), then the account.
- The chosen path is written to `root` only after the user confirms it.
- If the `root` file exists but cannot be read for a reason other than "not found", fall back to `<appData>` as the root.

Validation applies to the onboarding picker and to "Change location". Each failure has a reason code with a dedicated message:

- `bad`: the path is `/`, or lies inside the app bundle or executable directory;
- `nondirectory`: the path exists and is a file;
- `noperm`: the path is not writable, tested by creating and deleting a random hidden temp file;
- `invalidchar`: the path contains characters that break Java or Minecraft;
- `exists`: optionally, the target is non-empty and not a recognized data root.

If the current root becomes invalid at runtime, for example an unplugged external disk, set `invalidDataRoot` and show a blocking banner with "Choose another location".

Changing the location (migration):

1. Validate the destination. If it equals the current root (after resolving the path), do nothing.
2. Relaunch the app with a "migrate to <dest>" argument. Strip any stale migrate arguments left over from a previous attempt first; a stale argument would otherwise win.
3. On startup with that argument, copy the data with a progress window, rewrite `root`, and continue.
4. On failure, keep the old root and report the error.

Other actions in the same row are "Show in Finder" and "Browse…".

Dropped: "Migrate from another launcher" (the migration wizard).

### 2.2 General

| Setting | Type / default | Effect |
|---|---|---|
| `general.developerMode` | bool, `false` | Shows developer affordances: extra diagnostics, raw error details, the option to add offline accounts without a Microsoft account (see `accounts.md` §6.3), opening devtools. |
| `general.streamerMode` (UI pref) | bool, `false` | Masks emails and usernames in the UI, for example the login field becomes a password field. Stored renderer-side in XMCL. Amethyst may store it in either place. |
| `launch.replaceArm64Natives` | enum `legacy-only` \| `all` \| `off`, default `legacy-only` | **Important on Apple Silicon.** When resolving a version for launch, swap the LWJGL and other native libraries for arm64 macOS builds. `legacy-only`: only for Minecraft versions below 1.19, where Mojang shipped no arm64 natives. `all`: for every version. `off`: never; old versions then need an x86_64 Java under Rosetta. The mapping table of replacement artifacts lives in the launch/install spec. |
| `general.commandPaletteShortcut` | string accelerator, `''` (built-in default, for example ⌘K) | Global in-app shortcut that opens the command palette. Empty means the default. |
| `appearance.vibrancy` | bool, `false` | macOS vibrancy: the main window is created with a vibrancy material (sidebar style) and a transparent background, so theme colours with alpha show the desktop blurred through. Requires recreating the window, so prompt for a restart. XMCL had this setting but no UI for it; Amethyst should expose it under Appearance. |

### 2.3 Global game settings (launch defaults)

An instance overrides each of these. An instance value of "unset" (undefined) means "use global". An empty array or empty string set on the instance **does** override. The UI must show which value is in effect and offer "reset to global" per field.

| Setting | Type / default | Effect |
|---|---|---|
| `launch.javaPath` | path, `''` | Preferred Java executable. When the instance has no explicit Java, try this one first. Use it only if it is compatible with the instance's required Java major version and architecture (arm64 preferred); otherwise fall back to auto-detection. `''` means no preference. |
| `launch.memoryMode` | enum `unassigned` \| `auto` \| `manual`, default `unassigned` (the original stored this as a boolean-or-"auto" value) | `unassigned`: pass no `-Xms`/`-Xmx`, so the JVM chooses. `manual`: use the min and max below. `auto`: compute the memory from the mod count (below). |
| `launch.minMemoryMB` | int MB, `0` | `-Xms` in manual mode. 0 means omit. |
| `launch.maxMemoryMB` | int MB, `0` | `-Xmx` in manual mode. 0 means omit. |
| `launch.jvmArgs` | string[], `[]` | Extra JVM arguments, appended. Empty entries are dropped. Edited as a list of chips or rows with add and remove. |
| `launch.gameArgs` | string[], `[]` | Extra game arguments, appended. Empty entries are dropped. |
| `launch.wrapperCommand` | string, `''` | A command placed before the java executable. The launch runs through a shell when it is set. Example: a wrapper or profiler. |
| `launch.preLaunchCommand` | string, `''` | A shell command run before launch, in the instance directory. The launch waits for it. A non-zero exit aborts the launch with its output. |
| `launch.env` | map, `{}` | Environment variables for the game process, merged over the launcher's environment. The instance env overrides per key. |
| `launch.resolution` | `{width?, height?, fullscreen?, monitor?}`, `{}` | Default window size, or fullscreen. Presets offered: 854×480, 1280×720, 1920×1080, and so on. Monitor selection picks the display for fullscreen. |
| `launch.skipVerification` | bool, `false` | Skip the asset and library integrity check before launch, and skip online token validation. |
| `launch.hideLauncherWhileRunning` | bool, `true` | Hide the launcher window while the game runs and restore it when the game exits. |
| `launch.openLogOnStart` | bool, `false` | Open the live game log window when the game starts. |

**Auto memory, as XMCL computes it.** With no mods, `-Xms` = 1024 MB. Otherwise `level = mods/25`, and `-Xms = floor(level)·1024 + (frac(level) > 0.5 ? 512 : 0) + 1024` MB. Auto mode sets **only** `-Xms` and no `-Xmx`. That is a defect (see Pitfalls).

Amethyst should define `auto` properly. Set both `-Xms` and `-Xmx` from a heuristic based on:

- mod count;
- total physical memory, leaving at least 25% or 2 GB free for macOS;
- the Minecraft version, since newer versions need more.

Clamp the result to [1024, physical − 2048] MB and show the computed value in the UI.

**Manual-mode quirk in XMCL.** `-Xms` was applied only if min > 0, and `-Xmx` only if max > 0, each independently. Amethyst should validate min ≤ max and warn when max exceeds 75% of physical RAM.

The memory UI shows total and free system memory, through a "get memory status" call. It has a dual-handle slider for min and max, and preset chips.

### 2.4 Network

| Setting | Type / default | Effect |
|---|---|---|
| `network.proxyEnabled` | bool, `false` | Turns the proxy on or off without forgetting it. |
| `network.proxyUrl` | URL string, `''` | Edited as host + port fields and stored as `scheme://host:port`. The scheme defaults to `http:` if the user types a bare host. A host that already contains a port is accepted, and the explicit port field wins. Applied to: (a) all launcher HTTP traffic (downloads, APIs) and the Electron session; (b) Java subprocesses the launcher spawns, such as mod-loader installers, via `-Dhttp(s).proxyHost/-Dhttp(s).proxyPort`. If the field is empty and `HTTPS_PROXY`/`https_proxy` is set in the environment, use that. Invalid URLs are logged and ignored. Changes apply live. |
| `network.maxConnectionsPerHost` | int, `64` | Maximum concurrent connections per host for file downloads. ≤ 0 means the default. Applies live. |
| `network.maxApiConnections` | int, `16` | Maximum concurrent connections for API calls (Modrinth/CurseForge/Mojang). XMCL had this in its schema but no UI. Amethyst can expose it under an "Advanced network" disclosure. |

Edits in the Network section must be committed **on change**, debounced. XMCL committed them only when the page unmounted (see Pitfalls).

Dropped: `apiSetsPreference` and `apiSets` (download mirrors such as BMCLAPI), and the "use mirror" selector.

### 2.5 Updates

| Setting | Type / default | Effect |
|---|---|---|
| `updates.autoDownload` | bool, `false` | Download available launcher updates in the background. |
| `updates.installOnQuit` | bool, `false` | Apply a downloaded update when the app quits. |
| `updates.includePrereleases` | bool, `false` | Include pre-release builds in update checks. |

The UI shows:

- the current version and a "Check for updates" button;
- the release notes dialog for an available update, with Download and Install & Relaunch;
- a link to the GitHub releases page.

If automatic updating is unavailable, the UI says so and offers a manual download link. On macOS, Squirrel/electron-updater requires a signed app, so this happens on unsigned builds or with a read-only `/Applications` copy.

### 2.6 Theme source

| Setting | Type / default | Effect |
|---|---|---|
| `appearance.themeSource` | enum `dark` \| `light` \| `system`, default `system` | Mirrors the active theme's dark mode (§4.2) into Electron `nativeTheme.themeSource`, so native menus, dialogs, the scrollbar style and the vibrancy material match. Update it **live** whenever the theme's mode changes. XMCL applied it only once at startup. Invalid values fall back to `system`. |

### 2.7 Advanced: reset / export / import

- **Reset all settings** asks for confirmation, then restores defaults for `settings.json`, the UI preferences and the theme (`theme.json`, `theme.css`, `theme-media/`), and relaunches the app. It must **not** touch accounts, instances or the data root. XMCL's reset only cleared renderer storage and quit, so most real settings survived (see Pitfalls).
- **Export settings** writes `amethyst-settings-YYYY-MM-DD.json`: `{ format: 1, exportedAt, appVersion, settings: <settings.json>, ui: <UI prefs> }`. Never include secrets. Exclude the data root path, because it is machine-specific.
- **Import settings** reads that file and validates it field by field, the same way as loading `settings.json`. Unknown keys are ignored. It applies the values and reloads the renderer. A file without `format` is rejected.

### 2.8 Dropped settings (out of scope for Amethyst)

| Original setting (described) | Why dropped |
|---|---|
| Launcher language; "sync game language" (write the launcher locale into `options.txt` `lang:` before launch); "show localized community content" | i18n is out of scope. Amethyst is English-only. |
| Download API mirror preference and the mirror list | Download mirrors. |
| Global "disable authlib-injector" and "disable Ely.by authlib" | Third-party auth. |
| Discord rich presence toggle | Discord RPC. |
| Multiplayer transport choice, peer TURN preference, "show peer network info" | P2P multiplayer. |
| AI agent endpoint, model and API key; custom-CSS "assistant" | AI agent. |
| Linux custom title bar | Linux. |
| Dedicated-GPU assignment for the JVM | Windows/Linux GPU assignment. Apple Silicon has one GPU. |
| Disable telemetry | Amethyst ships no telemetry. If telemetry is ever added, reinstate this as opt-in. |
| Big Picture and gamepad preferences, Steam Deck prompt | Big picture / gamepad. |
| Server status cache | Server status ping. |

---

## 3. UI preferences (renderer-side)

These are view state, not launcher behaviour. Persist them in renderer storage under one namespaced key, or in a `ui-prefs.json` written through IPC. The second is better, because it survives a renderer storage reset and can be exported.

### 3.1 Kept

| Preference | Type / default | Effect |
|---|---|---|
| `ui.selectedInstance` | string | Last selected instance. Restored on start. |
| `ui.selectedAccount` | string | Move this into `accounts.json` (see `accounts.md` §1.3). |
| `ui.instanceGrouping` | `plain` \| `folder` \| `date`, `plain` | How the instance list is grouped. |
| `ui.instanceFolders` | JSON | User-defined instance folders/groups and their order. |
| `ui.marketInstalledFilter` | `off` \| `group` \| `hide`, `group` | How installed items are shown in the mod marketplace view. |
| `ui.denseLists.{mods,resourcePacks,shaderPacks,saves}` | bool, `false` | Compact list rows. |
| `ui.sort.{resourcePacks,shaderPacks,saves}` | sort key, `''` | Local list sort. |
| `ui.marketPageSize` | int, platform minimum | Search results per page. |
| `ui.marketProviders.{modrinth,curseforge}` | bool, `true` | Which providers are included in combined search. |
| Per-instance preferred source | `modrinth` \| `curseforge` \| `…Only` | Default marketplace source per instance. |
| `ui.showNews` | bool, `true` | Show the Minecraft news header on the home page. |
| `ui.screenshotBackground` | bool, `false` | Home background cycles through the instance's screenshots. |
| `ui.worldMapGrid` | bool, `true` | Grid overlay in the world map preview. |
| `ui.homeCards` / home card layout and order | JSON | Which home cards are visible per instance, and their order. |
| Audio: `ui.music.{playing,volume,shuffle}` | bool / float / bool | Background music player state (§4.6). Amethyst should move shuffle into the theme (`musicOrder`). |
| Login history | string[] | Previously used Microsoft emails, offered as autocomplete. |

### 3.2 Sidebar layout (Appearance section, with live preview)

| Preference | Type / default | Effect |
|---|---|---|
| `sidebar.style` | `classic` \| `notch`, `classic` | Classic: a vertical icon rail. Notch: a compact floating pill. |
| `sidebar.position` | `left` \| `right` \| `top` \| `bottom`, `left` | Edge the sidebar docks to. |
| `sidebar.align` | `start` \| `center` \| `end`, `center` | Alignment of the item group along the edge. |
| `sidebar.scale` | int %, `100` | Size multiplier for sidebar items. Suggested range 75–150. |
| `sidebar.autoHide` | bool, `true` | Collapse the sidebar when the pointer leaves it. Mostly relevant to notch style. |
| `sidebar.showOnlyPinned` | bool, `false` | Only pinned instances appear in the sidebar. |
| `sidebar.pinnedInstances` | string[], `[]` | Instance paths pinned to the sidebar, in order. |

macOS chrome: the main window uses a hidden title bar with inset traffic lights (about x 14, y 10). The renderer hides its own window controls on macOS and shifts the back button to clear the traffic lights. When the sidebar is on the left, it must reserve the traffic-light area.

---

## 4. Theme system

### 4.1 Concepts

- There is exactly one **global theme**, persisted in `theme.json` + `theme.css` + `theme-media/`.
- An **instance theme** optionally overrides the global theme while that instance is selected. It is stored inside the instance folder.
- **Stored themes** are named snapshots of a theme, packaged as files in `<appData>/themes/`. They can be saved, loaded, deleted, exported and imported.
- The **effective theme** is the instance theme if the selected instance has one and the override is not suppressed; otherwise the global theme. The Settings → Appearance page suppresses the instance override while it is open, so the user edits and sees the global theme.

### 4.2 Theme fields

Amethyst's own schema (`theme.json`, `format: 1`):

| Field | Type / default | Meaning |
|---|---|---|
| `mode` | `dark` \| `light` \| `system`, `system` | Colour scheme. `system` follows `prefers-color-scheme` live. |
| `palette.dark` / `palette.light` | colour sets (below) | Two independent palettes. Editing a colour edits the palette of the **currently resolved** mode. |
| `blur.background` | px 0–30, `0` | Gaussian blur applied to the background image, video or animation. |
| `blur.card` | px 0–30, `20` | Backdrop blur behind cards and panels. |
| `blur.sidebar` | px 0–30, `4` | Backdrop blur behind the sidebar. |
| `blur.appBar` | px 0–30, `4` | Backdrop blur behind the top bar. |
| `background.type` | `none` \| `image` \| `video` \| `particles` \| `halo`, `none` | What is drawn behind the UI. |
| `background.image` | Media? | Image or video used in light mode, and in dark mode too if no dark-specific one is set. |
| `background.imageDark` | Media? | Optional dark-mode-specific image or video. |
| `background.fit` | `cover` \| `contain`, `cover` | CSS object-fit for the image or video. |
| `background.colorOverlay` | bool, `true` | Draw the palette `background` colour, which usually has alpha, over the image or video on pages other than Home. Home always shows the media unobstructed. With `type: none` the background colour is always drawn. |
| `background.videoVolume` | 0–1, `0` | Volume of a background video. 0 means muted. |
| `background.particleMode` | `push` \| `remove` \| `repulse` \| `bubble`, `push` | Click/hover interaction of the particle animation. |
| `music.tracks` | Media[], `[]` | Background music playlist. |
| `music.order` | `sequential` \| `shuffle`, `sequential` | Playback order. |
| `font` | Media?, none | Custom UI font (ttf/otf/woff/woff2). |
| `fontSize` | px, `16` | Root font size. All rem-based sizes scale with it. Clamp it to 12–22 (see Pitfalls). |
| `rounded` | bool, `true` | Rounded corners on cards, buttons and inputs. When false, all shared radii become 0. |
| `customCssEnabled` | bool, `false` | Apply `theme.css`. |

Palette colour set: every value is a hex colour with optional alpha (`#RRGGBB` or `#RRGGBBAA`). Normalise 6-digit values to 8-digit with `FF` on load, so alpha-aware CSS works consistently. The roles are:

| Role | Used for | Editable in UI |
|---|---|---|
| `primary` | Buttons, links, selection, focus rings | yes |
| `accent` | Secondary highlights, badges | yes (XMCL: stored but not editable) |
| `background` | Window background / overlay over media (alpha matters) | yes, paired with `blur.background` |
| `card` | Card and panel surfaces (alpha matters) | yes, paired with `blur.card` |
| `sidebar` | Sidebar surface (alpha matters) | yes, paired with `blur.sidebar` |
| `appBar` | Top bar surface (alpha matters) | yes, paired with `blur.appBar` |
| `info`, `success`, `warning`, `error` | Status colours | yes (XMCL: only warning and error were editable) |

Amethyst defaults (its own brand, not XMCL's):

- primary is **neutral**: the label colour, near-white (`#ECECEF`) in dark mode and near-black (`#1C1C1F`) in light mode, so primary fills are white with dark text in dark mode and near-black with white text in light mode. No purple anywhere (DECISIONS.md, "Visual direction"). A stored `#9B5DE5`, the old purple default, is read as the neutral default;
- dark: a near-black window (`#0F0F11`) and a translucent `sidebar`; cards are hairline-outlined rather than filled;
- light: a white window and a light translucent `sidebar`;
- status colours: conventional Material-like values. Pick them to pass WCAG AA on the default surfaces.

Media object: `{ url, type: image|video|audio|font, mime }`. `url` points to a launcher-served local file (§4.5) or to a remote `https` URL.

### 4.3 Applying the theme

When the effective theme or the resolved mode changes, the renderer:

1. Switches the component library between dark and light, and sets `nativeTheme.themeSource` through settings (§2.6).
2. Pushes the role colours into the component library's theme (primary, accent, info, success, warning, error).
3. Writes CSS custom properties on `:root`:
   - `--color-primary`, `--color-accent`, `--color-info`, `--color-success`, `--color-warning`, `--color-error`;
   - `--color-bg`, `--color-card-bg`, `--color-sidebar-bg`, `--color-appbar-bg`;
   - `--color-border` and `--color-highlight-bg`, which must **differ** between dark and light (for example white-12% in dark, black-12% in light);
   - `--color-secondary-text`;
   - `--blur-card`, `--blur-sidebar`, `--blur-appbar`.

   The `html` and `body` background is `--color-bg`. The app root is transparent, so the background layer shows through.
4. With a custom font: injects an `@font-face` for a "custom" family pointing at the font URL, then sets the app font stack to `custom, <default stack>`. Sets `html { font-size: <fontSize>px }`.
5. With `rounded` false: overrides the component defaults so the radius is 0 everywhere.
6. Injects the effective custom CSS last (§4.7), so it can override everything.

Background layer: one full-window layer behind all content, chosen by `background.type`:

- `image`: an `<img>` with the resolved image, the fit and the blur filter.
- `video`: a `<video autoplay loop playsinline>` with the fit, blur and volume (muted when the volume is 0).
- `particles`: an interactive particle canvas (any small particle library) in a light grey colour, with the chosen click mode, blurred.
- `halo`: an animated soft radial-gradient glow.
- `none`: nothing.

Then the colour overlay is drawn on top according to `colorOverlay` (§4.2). Transitions between backgrounds cross-fade.

Resolved image: in dark mode, `imageDark` if set, otherwise `image`. In light mode, `image`.

Performance and pausing:

- The video and particles **pause while a game is running**, and resume when the last game process exits.
- Also pause when the window is hidden or minimized.
- Animations respect `prefers-reduced-motion`: halo and particles become static.

### 4.4 Editing UX (Appearance section)

- **Mode**: a three-way toggle (Dark / Light / System) and a "Reset palette to default" button. The reset affects only the currently resolved mode's palette.
- **Colours**: one row per role. Each row has a swatch button that opens a colour picker with an alpha channel and preset swatches. Surface roles also have a blur slider (0–30) inline.
- **Background**: choose the type, then:
  - Image: "Select file…" (images), "Use desktop wallpaper", "Enter URL…", "Clear", and a fit selector.
  - Video: "Select file…" (videos), "Enter URL…", "Clear", the fit selector and a volume slider (0–1, step 0.01).
  - Particles: the interaction mode.
  - The "Colour overlay" toggle.

  Selecting a file **copies** it into the media folder (§4.5). Replacing or clearing a launcher-local media file deletes the old copy. Remote URLs are not downloaded. Their media type comes from a HEAD request's `Content-Type`, falling back to the file extension (png/jpg/gif/webp/svg; mp4/webm/ogg; mp3/ogg/wav/flac; ttf/otf/woff/woff2).
- **Background music**:
  - Add a file or URL, remove a track (which deletes the local copy), and reorder tracks.
  - The order toggle, sequential or shuffle.
  - The player is a small widget in the top bar or footer with play/pause, previous, next and volume. Scrolling the mouse wheel over it changes the volume.
  - Playing state and volume persist across restarts.
  - Music pauses while a game runs, and resumes afterwards only if it was playing before.
  - When a track ends, advance; with a single track, loop it.
  - Shuffle never repeats the same track twice in a row, and must handle a single-track playlist (see Pitfalls).
- **Font**:
  - Select a font file (ttf/otf/woff/woff2), enter a URL, or reset. Reset deletes the local copy and resets the size to 16.
  - The size has −/+ buttons with a 1 px or 0.1 px step toggle, and a read-only value display, clamped.
- **Rounded corners**: a switch.
- **Custom CSS**: an enable switch and an editor (a monospace dialog with syntax highlighting). Saved content is capped at 1 MB; reject larger saves with a message.
- **Theme store**:
  - "Save current as…" takes a name. It must be a valid filename; an existing name prompts before replacing.
  - A list of saved themes. "Load" asks for confirmation, because it replaces the current theme and its media; "Delete" removes it.
- **Share**: "Export theme…" opens a save dialog. "Import theme…" opens an open dialog.
- All edits apply **live** and are saved with a debounce of about 800 ms.
- Changes from a theme file reload the editor state.

The same Appearance editor, without the theme store and without the agent features, is reused on the **instance settings** page to edit that instance's theme (§4.8).

### 4.5 Media storage and serving

- Global theme media is copied into `<appData>/theme-media/`. Instance theme media is copied into `<instance>/theme/`.
- **Collision rule.** XMCL kept the source file's base name, so two different `background.png` files overwrote each other. Amethyst must store media as `<sha1>.<ext>`, or as `<basename>-<short-hash>.<ext>`, which is collision-free and deduplicated.
- **Type check by content.** Accept only files whose sniffed MIME (magic bytes) is `image/*`, `video/*`, `audio/*` or `font/*`. SVG cannot be sniffed: accept it by extension plus an XML/`<svg` prefix check. Reject everything else with "Unsupported media type".
- **Serving.** Register a privileged custom protocol in Electron, for example `amethyst-media://theme/<file>` and `amethyst-media://instance/<instance-id>/<file>`:
  - resolve the file name with basename only;
  - verify the resolved path stays inside the expected folder, and respond 403 otherwise;
  - respond 404 if the file is missing;
  - set `Content-Type` from the sniffed type;
  - support HTTP Range requests, which `<video>` and `<audio>` seeking needs.

  XMCL also had a generic "serve any absolute path that sniffs as media" endpoint (used for skins and previews). Amethyst must **not** expose arbitrary-path reads. Serve only known directories, or hand the renderer short-lived tokens for user-picked files.
- **Desktop wallpaper (macOS).** XMCL asked Finder for the desktop picture via AppleScript (`osascript`). On macOS 13+ this triggers an Automation permission prompt ("Amethyst wants to control Finder"). For dynamic or system wallpapers it returns a `.heic` file or nothing at all, and Chromium cannot decode HEIC. Amethyst should:
  1. Try the user's current wallpaper URL through a small native helper or an AppleScript call to System Events, with graceful denial handling.
  2. If the file is HEIC, convert it to JPEG with `sips -s format jpeg` into the media folder.
  3. If nothing is available, show "Couldn't read your wallpaper", not a silent no-op.

### 4.6 Persistence of the theme

- `theme.json` is the serialized global theme (§4.2 schema). Write it atomically. If it is missing or invalid, use the defaults. Validate fields individually, as for settings.
- Media references in `theme.json` are launcher media URLs, so the file is portable within one machine.
- Saving happens in the main process (file IO). The renderer sends a plain JSON clone, never framework proxies. XMCL crashed IPC with "object could not be cloned" when it sent reactive proxies.

### 4.7 Custom CSS

- The global CSS lives in `<appData>/theme.css`. An instance's CSS lives in `<instance>/theme.css`. Content is capped at 1 MB. Saving an empty string deletes the instance file.
- Effective CSS:
  - if an instance theme is active, the instance's CSS, but only if the **instance** theme's `customCssEnabled` is true;
  - otherwise the global CSS, if the global `customCssEnabled` is true.

  It is injected as one `<style>` element, replaced in place on change. Changes made by another window or process are broadcast as an event, so every window refreshes.
- **Background video via CSS.** If the effective CSS declares `--custom-background-video: url("…")`, that URL is played as the background video. It takes precedence over the theme's background, and the colour overlay is not drawn. This lets shared themes ship animated backgrounds.
- Security: custom CSS can load remote URLs (fonts, images), which leaks the user's IP to that host when the theme loads. Keep the default CSP for remote images (allow `https:`) and tell users that imported themes can reference remote content. Never allow CSS to reach `file:` URLs; use the media protocol.

### 4.8 Instance themes

- Stored in the instance folder: `theme.json` (same schema), `theme.css`, and `theme/` for media.
- **Enable**: "Use custom theme for this instance" starts from a copy of the current global theme.
- **Save**: when an instance theme is saved, every media item that points into the global media folder (or the launcher image store) is **copied** into the instance's `theme/` folder and re-pointed. The instance then stays self-contained when its folder is exported, duplicated or moved. Repeated references to the same source are copied once.
- **Clear**: "Remove instance theme" deletes `theme.json` and `theme.css`. It may keep or delete `theme/`; deleting is preferred.
- After saving, reload from disk so the UI reflects the localized URLs.
- When the selected instance changes, load its theme. The effective theme switches immediately, including the background.
- The music player follows the **effective** theme's playlist. XMCL always used the global playlist (see Pitfalls).
- Instance themes are included in instance export and duplication automatically, because they live in the folder. Modpack export (see `modpacks.md`) should exclude `theme/`, `theme.json` and `theme.css` by default.

### 4.9 Theme package format (stored, export, import)

A theme package is a zip file with the extension `.amtheme`, containing:

- `theme.json`: the serialized theme, with media URLs rewritten to `assets/<file>` relative references;
- `assets/<file>…`: every launcher-local media file the theme references;
- `theme.css`: optional, the custom CSS.

**Export / save to store**:

- Zip the current `theme.json`, the referenced media from the media folder, and the current CSS.
- Remote `https` media stays as URLs.
- Media files that are missing on disk are skipped, with a warning.
- When saving to the store, the destination is `<appData>/themes/<name>.amtheme`, which replaces an existing file of that name. Export appends `.amtheme` if the extension is missing.

**Import / load from store**:

1. Open the zip. Require `theme.json`, and reject the package without it ("Invalid theme file").
2. Validate the theme JSON.
3. **Sanitize entry names.** Accept only `assets/<basename>` entries whose basename is not empty, not `.` or `..`, has no path separators, and matches the allowed media types by content. XMCL wrote entries to `media/<name>` without checking them (zip-slip, see Pitfalls).
4. Extract the media into a **staging** folder first. Only when every step succeeds, swap it in as the media folder, write `theme.json` with rewritten URLs, and write the CSS (an empty CSS clears the current one). If any step fails, leave the current theme intact.
5. Importing a file from outside the store also copies it into the store under its base name. Loading from the store must not copy a file onto itself.
6. Size limits:
   - total uncompressed size at most 200 MB;
   - at most 50 entries;
   - CSS at most 1 MB.

**Compatibility (maybe).** XMCL's `.xtheme` packages use the same basic layout: a JSON manifest at the root, an `assets/` folder and an optional CSS file. Their manifest has an older, flatter key naming, with colours split into light- and dark-prefixed keys and settings in a flat map. An importer for it is optional. If built, map the colours by role and mode, map the flat blur, background and font settings onto §4.2, and default anything unknown.

**Legacy migration.** Not applicable, since Amethyst has no prior versions. Do not port XMCL's localStorage-v0 to backend migration.

---

## 5. Onboarding ("Setup")

This is the first-run flow, shown before the main UI when no data root is set.

1. **Data location**: a picker with the suggested default, validated as in §2.1. Continue is disabled until the path is valid.
2. **Appearance**: Dark / Light / System, shown with a live preview. The choice writes both the theme's `mode` and `themeSource`. XMCL wrote only the settings value, so the theme's own mode could override it right after setup.
3. **Account**: the Microsoft login form (see `accounts.md`), with "Skip for now".
4. Finish: write `root`, close setup, and optionally start a short UI tour.

---

## Appendix: maybe (collections / favourites)

XMCL had local "collections": user-named lists of marketplace projects (Modrinth/CurseForge), with "install all into instance". It also synced Modrinth collections when logged into Modrinth. If Amethyst adds them:

- store them in `<appData>/collections.json` as `[{id, name, description?, icon?, items: [{provider, projectId, addedAt}]}]`;
- offer a "favourite" heart on project pages that adds to a default "Favourites" collection.

Modrinth account sync is out of scope.

---

## Pitfalls / bugs observed in the original

1. **Defaults defined in three places that disagree.** The persisted-schema defaults, the in-memory class defaults and the UI fallbacks differed:
   - hide-launcher: schema true vs in-memory false;
   - Discord presence: true vs false;
   - max sockets: 64 in the schema, 16 in the config fallback, 0 in memory;
   - disable-authlib: UI fallback true vs schema false.

   The visible default depended on whether `setting.json` existed. Define each default once, in the schema, and derive everything else from it.
2. **Runtime state mixed into the settings object.** Update status, online flag, disk-full flag and DB-ready lived next to persisted fields. Separate them.
3. **"Reset all settings" did not reset settings.** It cleared renderer localStorage, sessionStorage and IndexedDB, then quit. `setting.json`, `theme.json` and `theme.css` survived. It also wiped unrelated renderer state, including caches and the selected account.
4. **Settings export covered only renderer localStorage**, not `setting.json`, and it hard-coded a stale launcher version string into the export.
5. **Network fields committed on page unmount only.** Proxy host/port and max sockets were written when the Network page was closed. Quitting the app with the page open lost the edits.
6. **TLS verification disabled.** The download HTTP stack was configured with `rejectUnauthorized: false`, so certificate errors were silently ignored for every download. Amethyst must verify TLS. If a proxy with its own CA is needed, trust the system keychain; Electron's `net` module does this on macOS.
7. **Auto memory set only `-Xms`.** No `-Xmx` was passed, so the JVM default maximum (¼ of RAM) applied, and heavy modpacks could OOM even though "auto" suggested managed memory.
8. **nativeTheme updated only at startup.** Changing dark/light in-session left native menus and dialogs in the old scheme until restart. After onboarding, the setup choice and the theme's own mode could also fight.
9. **`--color-border` and highlight were identical in dark and light.** Both used white at 12%, so borders were nearly invisible on light themes.
10. **Inconsistent theme defaults.** The "default theme" had blur values 3/20/3/3 (background/card/sidebar/appBar) and overlay true. Deserializing a theme without those keys produced 0/22/4/4 and overlay false. A freshly imported minimal theme therefore looked different from "Reset".
11. **Several palette roles were stored but not editable.** Accent, info and success had no UI. Expose all roles or drop the unused ones.
12. **The theme's music play order was ignored.** The theme stored a play order, but the player used a separate localStorage shuffle flag. The music player also always read the **global** theme's playlist, even when an instance theme with its own music was active.
13. **Shuffle with one track could hang.** "Next" in shuffle mode looped picking a random index until it differed from the current one, which never terminates with a single track.
14. **Font size had no bounds.** The −/+ buttons could drive the root font size to 0 or below, which made the UI unusable with no easy way back.
15. **Media file name collisions.** Media was stored under its original base name, so adding a second `bg.png` overwrote the first, even if an older stored theme still referenced it.
16. **Zip-slip in theme import.** Entries under `assets/` were joined onto the media folder without rejecting `..` or nested paths. The media folder was also emptied **before** extraction, so a failed import left the user with no media and a half-written theme.
17. **Loading a stored theme copied the file onto itself.** Load-from-store re-used import, which copies the package into the store directory.
18. **Arbitrary-path media endpoint.** A launcher URL accepted any absolute path and served it if it sniffed as image, video or audio. Any content running in the renderer, including injected custom CSS URLs, could probe the local filesystem through it. Serve only whitelisted directories. Separately, the launcher's local HTTP server listened on all interfaces. Bind any local server to 127.0.0.1.
19. **Desktop wallpaper on macOS.** The AppleScript/Finder approach triggers an Automation permission prompt, fails for dynamic wallpapers, and returns HEIC that Chromium cannot display. Failures were silently ignored.
20. **Debug logging left in.** The background component logged its type and image on every change, which is noise in production logs. Strip it.
