# UI and UX specification (macOS 13+, Apple Silicon)

Status: this is a product and UX specification for Amethyst. It is based on the observable behaviour of the reference launcher (XMCL), not on its code. Wherever this spec says "the original", it describes screens and behaviour you can confirm by running XMCL. Wherever it says "Amethyst MUST/SHOULD", it states a requirement for the rewrite. Component structure, naming and layout code are deliberately left to the implementers.

Companion specs: `java.md` (Java discovery and auto-download) and `download.md` (download and task engine). Where this document mentions Java or download behaviour, those specs are authoritative for the logic. This one covers only how the behaviour is presented.

Contents:

- Part A: inventory of the original, limited to the KEPT scope
- Part B: proposed information architecture for Amethyst
- Part C: UX problems in the original, and how Amethyst fixes them

**Scope.** KEPT:

- instances
- version and loader install
- launch, logs and crashes
- mods, resource packs, shader packs and saves
- Modrinth and CurseForge
- modpack import and export
- Java
- Microsoft and offline accounts, plus skins
- settings
- themes and backgrounds
- the auto-updater
- telemetry consent

DROPPED, and not described here:

- p2p and multiplayer
- language switching
- server hosting and status
- Discord RPC
- big picture and gamepad
- AI agent
- Bedrock
- Modrinth publishing
- third-party (yggdrasil) auth servers
- download mirrors
- the migration wizard
- XMCL-service feedback dialogs
- FTB modpacks (dropped by the product owner, 2026-10-24)

**Product decisions (2026-10-24).** Every simplification proposed in Part B is approved:

- Cut: the Home card grid and focus mode; the theme extras (palette editor, particle and halo backgrounds, background music, custom fonts, custom CSS, theme store); mod-folder colours and shared folder rules; the network stats tab.
- Deferred until after v1: the world map viewer, the advancement viewer, and Modrinth account collections. v1 keeps local Favourites only.

---

# Part A: Inventory of the original (KEPT scope)

## A1. Window shell

**Layout.** A frameless window with a 30px custom title bar, a sidebar and a routed main area. Pages cross-fade when you navigate. An optional background (image, video, particles or WebGL "halo") sits behind everything, under a translucent tinted gradient.

**Title bar.** It holds, left to right:

- Back arrow, but only in one of the two sidebar styles.
- Tiny background-music player.
- Command-palette badge, showing its shortcut.
- Task badge, showing the active task count and the download speed.
- Contextual "Help" badge, which starts a guided tour.
- Feedback badge.
- Custom minimise, maximise and close buttons. On macOS these are hidden and the traffic lights are used instead.

**Sidebar.** There are two styles: "classic", a vertical icon rail that can also sit at the top or bottom, and "notch", a floating pill.

- Top of the sidebar:
  - Back
  - "My Stuff", which shows the player avatar and opens the Me page
  - Store
  - (AI agent, dropped)
- Middle of the sidebar: a scrollable list of instance icons, then a "+ Create" button.
- Bottom of the sidebar:
  - (Multiplayer, dropped)
  - Settings. A bare "1" badge appears here when an update exists.
- **Instance tile:**
  - a 48px icon
  - a selected indicator
  - a spinner overlay while launching
  - a play badge while running
  - a pin badge
  - a tooltip with the name and version chips (MC, Forge, Fabric and so on)
- **Tile interactions:**
  - Click selects the instance. If you are on a sub-page, it also navigates back to Home.
  - Double-click launches.
  - Drag reorders. Dropping onto the centre of another tile creates a group.
- **Groups (folders):**
  - Collapsed, a group shows a 2×2 mosaic of its members.
  - Expanded, the members appear inside a tinted pill.
  - "Folder Settings" lets you set a name and pick a colour with a full RGBA picker.
- **Instance context menu:**
  - Pin/Unpin
  - "Show only pinned" toggle
  - Group…, which opens a picker of existing groups or lets you type a new name
  - Show in folder. The label includes the full path.
  - Duplicate. This runs silently, with no prompt and no feedback.
  - Change icon
  - Delete
- **Shortcut:** Alt+← goes back.

**Always-mounted global surfaces:**

- context menu
- toast notifier
- command palette
- add-instance dialog
- game-exit (crash) dialog
- unauthenticated warning
- image viewer
- login and profile dialog
- folder settings

**First run.** A setup wizard replaces the whole shell (A13).

## A2. Home (selected instance)

**Sticky header.**

- Title: the instance name. It shrinks as you scroll.
- Second row: version chips on the left; launch status and launch button on the right.
- Icon actions:
  - Logs & Crashes
  - Open folder
  - Export modpack, which jumps to instance settings → Modpack
- Dragging a file over the header turns the whole header into a "drop modpack" target.

**Critical banner.** Shown at the top for two conditions:

- The database failed to open, or the disk is full. This is a red banner with a Settings button.
- "N resources have corrupted metadata". This is a yellow banner with a Mods button.

**Card grid.** A draggable, resizable dashboard. Layout is saved per instance and per breakpoint.

- Default cards: Mods, Resource Packs, Shader Packs, Saves, Screenshots, plus a "Blueprint" card. Server and World cards are opt-in.
- Each card shows:
  - an icon and a count, such as "N enabled"
  - a stack of item icons
  - an "Install" button, which opens the market view of that page
  - a "Manage" button
- Each card accepts dropped files.
- You can hide cards and restore them from a context menu.
- If every card is hidden, a centred "Show hidden cards" button appears.

**Focus mode.** A chevron divider hides the grid. In its place you get:

- a minimal footer with a screenshot carousel or a pinned-server card
- compact tiles
- the launch button

**Upstream panel.** Shown only for instances installed from a Modrinth or CurseForge modpack.

- Project header: icon, title, description, categories, downloads, followers, created/updated, and a Store link.
- Version list:
  - The "Current version" row is pinned at the top, with a switch for "only show current MC version".
  - The remaining versions are grouped by date and load with infinite scroll.
- Each version row shows: name, release/beta/alpha chip, loader icons, and an expandable changelog.
- Actions on each version row:
  - Update or Downgrade. On the current version this reads "Repair".
  - "Duplicate as new instance".

**Launch button.** A pill with a play button inset on the left and a gear inset on the right.

- Gear hover opens a menu. Gear click opens instance settings.
- The label and the click action depend on state:

| State | Label | Click does |
|---|---|---|
| Task running | Pause | Pauses the task |
| Launching | Cancel | Cancels the launch |
| Running | Kill | Opens a confirmation |
| Files missing | Install | Repairs the files |
| Normal | Launch | Launches; a darker shade means there is a Java issue |

- The hover menu contains:
  - Instance settings
  - Manage ▸ (Logs, Folder, Export modpack, Export server)
  - Install from modpack
  - Launch as ▸ (other accounts)
  - Launch to ▸ (servers and worlds; joining a server is dropped, joining a world is kept)

**Launch status, next to the button.**

- During an install: the task name, a thin bar, and "x MB / y MB". Clicking opens the task centre.
- Otherwise: the first diagnostic item. Hovering lists all of them.

## A3. Launch dialogs

- **Launch status dialog.**
  - Shows a spinner with typed text: "Launching…", which changes to a "slow" message after 4s.
  - A sub-hint names the phase: refreshing user, assigning memory, spawning process.
  - "Skip" buttons appear if the account refresh takes more than 5s.
  - The dialog closes automatically when the game window appears.
- **Kill confirm.** Cancel / Yes (graceful) / Force kill.
- **Java issue.**
  - Shown when Java is invalid, incompatible or missing.
  - Lists the hints, with Cancel and "Switch to Java N".
  - It also offers "Launch anyway", which permanently whitelists that Java for the instance. The whitelist can never be viewed or reset.
- **Multiple instances.** "You are launching multiple instances. Are you sure?" with Cancel and "Yes, Launch".
- **Launch blocked.** A persistent error dialog with a title and description for each failure type:
  - bad version JSON
  - invalid Java path
  - no permission
  - no suitable Java
  - no version selected
  - failed to spawn
  - pre-launch command failed
  - abnormal exit

  An optional read-only text area holds the details. The only button is OK.
- **Unauthenticated warning.** Shown when there are zero accounts: "Not logged in, game will launch in demo mode", with Sign In / Play Anyway / ✕. An expired account does **not** trigger this.
- **Unresolved files.** Files that could not be downloaded.
  - Each row shows: file name, a "Matched" chip (with source) or "Not found", the hash or path, and "via Modrinth hash / Modrinth / CurseForge".
  - Actions: Search sources, Ignore N, Install N matched.
  - The checkbox means "ignore", which is the reverse of what users expect.
- **Checksum failures ("install skip").** Lists each file with its expected and actual hash.
  - "Ignore" only closes the dialog, despite having a retry icon.
  - "Skip" accepts the bad files.

## A4. Logs and crashes

- **Log dialog** (1200px wide).
  - Tabs: Logs and Crashes (Server Logs is dropped).
  - The left list shows files. Each has "show in folder" and "delete"; delete has no confirmation.
  - Header: back, file name, copy.
- **Log viewer.**
  - fuzzy search
  - virtualised rows coloured by level, with level, time and source columns
  - consecutive identical lines collapsed into "×N"
  - a floating "scroll to bottom" button; the view follows the tail
- **Crash reports.** Shown as raw preformatted text.
- **Game exit / crash dialog.**
  - Opens automatically on a non-zero exit. A user kill is ignored.
  - Title is "Crash" or "Launch failed", with "Open crash report folder" or "Open log folder".
  - Body: a short description, the crash text, and the latest log, both as raw preformatted blocks.
- **Separate live log window.**
  - One tab per game process, labelled "Minecraft {PID}".
  - It has the same viewer, plus a dead hamburger icon and a theme toggle.
  - With no game running, it is blank.
  - Tabs are never removed.
  - There is no copy, export or clear.

## A5. Create instance

A single large modal titled "Create Game" with one "config" step.

**Fields.**

- Name. The placeholder is an auto-generated unique name. It is validated for:
  - duplicates
  - illegal characters `<>:"/\|?*`
  - reserved names
  - dots or whitespace only
- Author, which defaults to the player name.
- Description.

**Version and loader.**

- A tile selector: Vanilla, Forge, Fabric, Quilt, NeoForge, OptiFine (LabyMod is dropped).
  - Clicking the active tile goes back to Vanilla.
  - Switching loader clears every other loader version. Because of this, OptiFine-on-Forge cannot be built here, even though the engine supports it.
- Rows:
  - A Minecraft version row, always shown.
  - A row for the selected loader's version. Picking a loader auto-selects its latest version.
- Each row's picker is an autocomplete with:
  - tag chips: Release/Snapshot, Recommended/Latest, Stable
  - a bug icon that shows snapshots or unstable builds
  - refresh
  - clear
- Empty state: "No Forge for 1.x.y". A retry is available on error.
- If the current value is filtered out (for example, it is a snapshot and snapshots are hidden), it is cleared silently.

**Advanced settings.**

- Java select (Auto, or one of the detected Javas).
- Min and max memory. Blank means automatic.

**Link shared folders.** Only for manual creation, not imports.

- Checkboxes: saves, resource packs, shader packs, options.txt, server list.
- The choices are remembered across the whole launcher.

**Footer.**

- Cancel.
- "Import modpack ▾", with Local file (.zip/.mrpack) and From URL.
- An inline error.
- Create. It is disabled while the form is invalid or files are unresolved.

**Matching an existing instance.** If the opened modpack matches an existing instance, an info banner offers "Update existing".

**On success.** The new instance is selected and you land on its Home.

**Escape.** Closes the modal, even while creation is running.

**Import folder.** In the original this exists only inside the dropped migration wizard. It has these sources:

- MultiMC/Prism
- Modrinth App
- CurseForge
- vanilla `.minecraft`

The wizard lets you browse to a folder, then shows checkbox lists of game folders and instances. There is no Back from step 2. Amethyst keeps the capability (B4.5) and drops the wizard.

## A6. Delete and duplicate instance

- **Delete dialog.**
  - A red icon, with the copy "removed from disk forever".
  - A box showing the name and full path.
  - "Delete files", checked by default.
  - No / Yes buttons.
  - After deleting: if it was the last instance, you go to the Me page; otherwise you go Home.
  - Hard-coded white text breaks the light theme.
- **Duplicate.** Runs silently from the context menu. You don't get to name the copy, and nothing confirms it.

## A7. Instance settings

A left nav on wide windows; tabs below 900px.

**Sections.**

- General
- Modpack
- Appearance
- Modrinth project and Server (both dropped)

**Unsaved changes.** All edits are staged in a persistent "Unsaved changes" snackbar with Reset and Save. While it is up, navigating away is blocked and the snackbar flashes red.

**Global/Local chips.** Every overridable setting has a "Global" chip (purple) or a "Local" chip (blue, with ✕ to reset). Clicking the chip jumps to global settings.

**General.**

- **Basics:**
  - icon, which opens a change-icon card
  - name
  - "Hide launcher on launch"
  - "Show log window"
- **Versions:**
  - the loader selector from A5
  - "Check integrity", which re-installs after a confirmation
- **Java:**
  - **Hero row.** A version badge, plus a title: "Java 21 (arm64)", Auto, Invalid, "No Java", or "No proper Java". In the last case the hint says to install a JRE, but there is no install button.
  - Path, open folder, refresh, import from file, and a "Change" picker. The picker lists Auto plus each Java with its path; delete has no confirmation.
  - **Memory:**
    - mode: Unassigned / Auto / Manual
    - a system RAM bar (free/total) with the allocated range drawn on top
    - min and max sliders plus MB fields, in 256MB steps
    - presets: 2/4/6/8/12/16 GB
  - **Advanced:** prepend (wrapper) command, JVM options, and an environment-variable table. Inherited global variables are read-only.
- **Launch:**
  - shared options.txt link
  - pre-launch command
  - Minecraft arguments
  - resolution: width/height, fullscreen, presets, and monitor select (only when there are several monitors)
  - Server and client argument preview: a numbered, colour-coded list with a Copy button.

**Changing the Minecraft version.** If the instance has mods, saving opens "Upgrade mods to X?". Choosing Upgrade **silently disables every mod that has no compatible update**.

**Modpack (export).**

- Metadata: modpack version with patch/minor bump buttons, author, description, URL.
- Format switches: CurseForge, Modrinth, Modrinth-strict. Also an export folder with Browse.
- File tree:
  - Client and Server tabs, with checkboxes, a filter, a size estimate, and "restore default selection".
  - Mods that come from a market source get client/server environment chips.
  - The default selection is mods, resourcepacks, config, scripts, shaderpacks and options.
- The Export button is in the page header.
- **Export failures are only logged to the console. The user sees nothing.**

**Appearance.** "Use instance-specific theme", which opens the same editor as A12.

## A8. Content pages: Mods, Resource Packs, Shader Packs, Saves

All four pages use one two-pane layout, with a list on the left and a detail pane on the right.

**Views.** Market, Installed and Favorites. The switch between them lives **inside the right-hand filter panel**, and it disappears as soon as an item is selected.

**Search.**

- Debounced at 500ms.
- `@id` jumps to a project.
- Chips show the active game version and category.
- Ctrl+F focuses the field. Cmd+F does not work on macOS.

**List header.**

- Count, such as "N mods / total X".
- Page-specific icon buttons.
- Dense/comfortable toggle.

**List rows.**

- avatar and title
- a red dot when an update is available
- a duplicate-file warning
- a gear menu
- the description
- a horizontally scrolling tag strip: author, downloads, followers, source, size
- for items not yet installed, a hover download button on the avatar that installs in one click

**Multi-select.**

- A header toggle turns it on.
- On Mods only, Cmd- or Shift-click also starts it, and Shift selects a range.
- ⌘A selects all installed items. Esc exits.

**Filter panel.**

- Market:
  - sort: relevance, downloads, follows, updated, newest
  - page size
  - Minecraft version chips
  - loader
  - environment
  - Modrinth categories (multi-select) and CurseForge categories (single-select), each with an on/off switch for that source
- Installed: a local sort plus filters specific to the page.

**Drop and empty states.**

- Dropping files anywhere installs them, with a big hint shown while dragging.
- Empty Installed view: "No installed content" with a "Browse market" button.
- Empty Market view: "No results".

**Mods page.**

- Banners:
  - "N duplicated mods" opens a dialog. One file per mod id is pre-picked to keep, and "Keep selected" deletes the others with no further confirmation.
  - Upgrade error.
- The Market list is split into installed-first, Search, and Unsupported sections. A three-state icon button cycles between: off, group installed, hide installed.
- **Row labels:**
  - a mod-id chip
  - dependency chips with ✔/❌, which search the market when clicked
  - editable user tags. You edit a tag by typing into the chip, which is hard to discover.
- **Context menu, single item:**
  - show file
  - delete (no confirmation)
  - enable/disable
  - open source URL
  - group/ungroup
  - apply or save shared group rules
- **Context menu, several items:** delete N, enable or disable N, and group.
- **Installed filters** (single-choice icon toggles):
  - disabled
  - incompatible
  - unused libraries
  - missing dependencies
  - has update
  - by loader
- **Options:**
  - Check dependencies, then Install.
  - "Remove unused libraries". This actually renames the files to `.disabled`.
  - Upgrade panel:
    - policy: Modrinth-first, CF-first, Modrinth-only, CF-only
    - "skip other MC versions"
    - "release only"
    - Check upgrade, then Upgrade. Upgrade shows a review dialog of the files that will be added and removed.
- **Groups (folders):**
  - A group row shows an icon mosaic, the name and a count, and collapses or expands.
  - From the group menu: rename/colour, enable or disable all, ungroup.
  - Group rules can be shared and applied to other instances.
- **Mod-loader wizard.** Shown when you enable a mod on vanilla. It lets you pick a loader.
- **Detail view for an unmatched local file:**
  - home, issues and source links
  - license, size, SHA-1
  - dependents
- **OptiFine detail:**
  - OptiFine versions for the current MC version, with changelogs
  - Install, which either sets the instance's OptiFine version or installs it as a mod on Forge

**Resource packs.**

- Sections: Selected, which is the ordered load list with drag handles, and Unselected.
- A pack-format compatibility chip (✔/❌, with the reason in a tooltip).
- Turning on groups **hides the load order**.
- Multi-select only supports Group. There is no bulk delete or bulk enable.
- "Link shared folder".
- Dropped files are installed and enabled.

**Shader packs.**

- Only one pack can be active at a time.
- If no shader mod is installed, a dialog lists Iris, OptiFine and Oculus, filtered by the instance's loader, plus "Skip for now".
- "Link shared folder".

**Saves.**

- Selected and Unselected sections.
- Each world's datapacks are listed as indented child rows.
- **World context menu:** show file, export, duplicate, delete. Delete has a confirmation.
- Dropping onto a world imports datapacks. Dropping onto the page imports worlds.
- Installing a market datapack uses an "Install to: [world ▾]" picker.
- **World detail:**
  - Properties: level name, seed, difficulty, cheats, game mode. Each has copy, and a pencil unlocks editing.
  - Progress tab: a canvas advancement tree with zoom, a filter, category tabs, and fullscreen.
  - Map tab: a top-down region map with dimension and Y-level controls. It also supports chunk select, copy, paste and delete.

## A9. Market project detail (inside content pages)

**Header.**

- icon and title (the title links to the website)
- refresh
- add-to-collection bookmark
- follow star (Modrinth)
- copy project id
- author (clicking searches by author)
- downloads and followers
- an archived banner when relevant

**Primary action.**

- Install, which reads "Switch" if a different version is installed. A hint next to it says, for example, "1 file + N required dependencies", or "no version supports X".
- Once installed: an Enable/Disable toggle and a red Delete (no confirmation).
- A hover menu, "Current version ▾".

**Tabs.**

- **Description:** collapsible Dependencies (each with install and progress) and Dependents, then the HTML body.
- **Gallery:** a grid with a lightbox.
- **Versions:** the installed version is pinned first. Each card shows type, loaders, MC version, downloads and date, and expands its changelog when selected.

**Side column.**

- a Modrinth ↔ CurseForge source switch, for projects listed on both
- categories, which add a filter when clicked
- links
- technical info, with copy buttons

**States.** Skeletons while loading; "Not found" when the project is missing.

## A10. Store (modpack browser)

**Left filters.**

- source toggles. Disabling a source draws a red ✕ over it.
- sort
- game version
- loader
- Modrinth categories
- CurseForge categories

**Landing (no query).**

- a "Trending" carousel with a 6s auto-advance
- a "Latest Minecraft" row with 8 packs and a reshuffle

**Search.**

- Shows "N projects" and chips for active filters.
- The clear-all button is labelled "Cancel".
- Results are a grid of cards: source badge, version, title, author, description, downloads, updated.
- Page-number pagination.
- Empty state: a "mood_bad" icon.

**Project page.**

- gallery carousel
- header with Install, plus Launch if an instance from this pack already exists
- members
- links and technical info
- the markdown description

**Install version dialog.**

- Step 1: a version list filtered by game version, loader and type, with a "Featured" divider.
- Step 2: changelog, dependencies, an alert describing the game version and loader the instance will get, and Install.

## A11. Collections and modpack import

**Collections.**

- Local collections: create, add or remove the current project, delete (no confirmation).
- Modrinth collections: an inline login prompt, Followed plus your collections, and delete. Deleting a **remote** collection has no confirmation.
- In the Favorites view: "Install all", which finds a compatible file for each project, shows a review, and lists the incompatible ones.

**Import paths.**

- Drop a .zip or .mrpack onto Home. A confirmation appears ("Import this modpack?" with the path), then the create modal.
- Paste a URL anywhere outside a text field. If it looks like a modpack link, the URL dialog opens. The same happens when a URL is dropped.
- The URL dialog: a URL field with a paste button, then step 2 with a version select.
- If the modpack matches an existing instance, the user chooses Cancel / Create new / Update existing.
- **Update existing instance** shows a review dialog:
  - a summary chip: "Add X · Remove Y · Keep Z"
  - a loader-change alert ("Forge 47 → NeoForge 21")
  - the new version values
  - a file tree. Each file has an operation chip (add, remove, keep, backup) and kept files can be hidden.
  - Start Update.

## A12. Accounts and skins (Me page, login dialog, skin library)

**Me page, left column.**

- **Account switcher card.**
  - head avatar, name, account type, or "Expired" in red
  - hover refresh
  - delete, which asks for confirmation
  - Clicking the card opens a dropdown of every account and profile, each with a validity label, plus "Add account".
- **3D skin viewer.** Idle, walk and run animations, and a name tag.
  - "Skin library" button.
  - A cape strip: "No cape" plus thumbnails of owned capes. Clicking one applies it immediately.

**Me page, right column.** A news carousel and an instance grid. Friends are dropped.

**Login dialog.**

- account type (Microsoft or Offline)
- username combobox with history
- For Microsoft, a password field that is always disabled.
- For Offline, a UUID field. The username must be 3–16 characters from `[A-Za-z0-9_]`.
- "Use device code" checkbox.
- Login button. While working it shows a spinner, which becomes "Cancel" on hover.
- A manual-URL fallback link.

**Login errors.** Mapped in detail, and worth keeping:

- invalid credentials
- network
- no Minecraft profile / doesn't own the game
- ownership check failed
- Xbox: child account (link to family settings), no Xbox profile, adult verification, region, banned
- rate-limited, with retry seconds
- service 5xx
- timeout
- cancelled

Microsoft errors appear **twice**: inline and as a toast.

**Skin editing.** There are three entry points: the drop canvas, a hidden action menu, and the library.

- **Skin library** (two panes):
  - Left: a 3D preview, Classic/Slim, "Equip to account", "Save current skin to library", Download.
  - Right: search, plus a grid of saved skins with equip, edit and delete. Delete has no confirmation.
  - The "New/edit skin" form has a name, Classic/Slim, and a source: a local file (drop or pick) or a URL or player name.
- Toasts report upload success or failure and an invalid skin size.

## A13. First-run setup

A full-window stepper on an animated background.

1. Language (dropped).
2. Appearance: Dark, Light or System.
3. Data folder:
   - the current path, with Default and Browse
   - a list of drives with usage bars; clicking one picks its suggested path
   - validation alerts
4. Account: the switcher, Add account, and Skip. "Confirm" does the same as Skip.

Footer: Previous / Next.

After setup, if the GPU and dark mode allow it, the background is silently switched to the halo shader.

**There is no telemetry step. Telemetry is on by default, and you can only opt out in Settings.**

## A14. Global settings

A single long scrolling page with a sticky left nav. Under 960px the nav becomes tabs.

**General.**

- data folder: path, Change, Open
- **Disable telemetry** switch (opt-out)
- developer mode
- streamer mode, which masks usernames
- command-palette hotkey recorder
- native library replacement

The Reset and Export/Import settings block is dead UI that is never shown.

**Appearance.** Very dense.

- **Sidebar:** style, position, alignment, auto-hide, scale, show only pinned.
- **Theme:** dark, light or system.
- **Colours:** seven colour dots with no labels (app bar, sidebar, primary, card, background, warning, error). Four of them also have a blur slider. There is a reset button.
- **Background type:** none, image, particle, halo or video.
  - Image: desktop wallpaper, fit, clear, select, or URL from a hover menu.
  - Video: fit, volume.
  - Background music list.
- Rounded corners.
- Font: size stepper, custom font file or URL.
- Custom CSS editor.
- Export/Import theme.
- Saved-theme chips. Deleting one has no confirmation.

**Global game defaults.**

- fast launch, hide launcher, show log
- default Java and memory (as in A7)
- JVM options, prepend command, environment variables
- Minecraft options
- resolution

**Network.** Proxy host and port; max sockets per host.

**About / update.**

- Version, a refresh button, a "NEW" chip, and an action whose label changes: "Already latest", then "Update to this version", then "Install and quit".
- Update info dialog: release notes, links, and Download / Install & restart.
- The only signal that an update exists is the "1" badge on the Settings icon. There is no toast.
- Also on this page: license, disclaimer, a raw JSON debug dump, and contributors.

## A15. Task centre, notifications, command palette, shortcuts

**Task centre.** A 700px modal opened from the title-bar badge. It closes whenever you navigate.

- Header: "N running · remaining · ETA · speed".
- Tabs:
  - Tasks. Each row shows an icon, an operation pill, the title, size, ETA and speed, a progress bar, and a percentage ring that becomes ✕ on hover. Finished tasks show Failed, Cancelled or Succeeded.
  - Connections. Per-host socket pool statistics. This is developer detail shown to everyone.
- Footer: "Clear finished".

**Notifications.**

- One toast at a time, top-right. The newest is shown first (LIFO).
- Duplicates merge into "×N".
- Info hides after 6s. Errors stay until dismissed.
- Toasts can carry action buttons.
- There is no history.

**Command palette.**

- Default shortcut Ctrl/Cmd+Shift+C. You can rebind it.
- Empty state: Recent instances (5) and commands.
- With a query, fuzzy results grouped as: Commands, Settings (toggles and selects edited inline), Instances, and Modrinth search.
- Per-instance submenu: Select, Launch, Duplicate, Delete.
- Keys: ↑↓, Enter, → (drill in), ← (back), Esc.
- Generic prompts use the browser's `prompt()` and `confirm()`.

**Complete shortcut list.**

- Palette.
- Alt+← to go back.
- Ctrl+F for search.
- Esc.
- ⌘A while in selection mode.
- ←/→ in the carousel.

There is no menu bar integration and no shortcut cheatsheet.

---

# Part B: Information architecture for Amethyst

## B0. Design principles

1. **Native first.** The app should feel like a Mac app, not a web app in a frame. That means:
   - a `hiddenInset` title bar with real traffic lights
   - a vibrancy sidebar (the `sidebar` material)
   - SF Pro via `system-ui`, at macOS type sizes (13pt body, 11pt secondary, 15–17pt headings)
   - native context menus and the native menu bar
   - native sheets for confirmation
   - native open/save panels
   - native notifications for events that happen in the background
   - `prefers-color-scheme` and `prefers-reduced-motion`, followed live
2. **One place per action.** Each action has a single canonical home. The menu bar, the context menu and ⌘K are allowed to mirror it. Ad-hoc duplicate buttons are not.
3. **Instance-centric.** Most of what you do is about one instance, so the instance is the main object. Its detail view owns all content management.
4. **No hover-only controls.** Anything that appears on hover MUST also be reachable by click, by keyboard and from the context menu.
5. **Destructive actions are reversible or confirmed.** File deletions go to the macOS Trash (`shell.trashItem`). If an action can't be undone, it asks for confirmation in a sheet. Toasts offer "Undo" wherever it is possible.
6. **Labels over icons.** Toolbars use SF-Symbols-style icons together with text, or show a tooltip that includes the shortcut. No three-state icon toggles.
7. **Safe by default.** Telemetry is off. Nothing is silently disabled, deleted or changed.
8. **Visual direction** (DECISIONS.md, 2026-10-28; reference: `docs/design/mockup.html`). Compact and neutral, like native macOS apps, Linear and Raycast:
   - Neutral by default: the accent is the label colour. Colour comes from content (icons, screenshots) and from status only. No purple, no decorative gradients, no novelty numerals.
   - Flat surfaces separated by hairlines; cards are outlined, not filled. Blur only on the sidebar (vibrancy), the ⌘K palette, popovers and menus, and the sticky table header.
   - 13px base type; 26px sidebar rows, 32px table rows; monospaced figures for versions, sizes and dates.
   - Ordered (Bayer) dithering for progress and for placeholder art when an instance or project has no icon.
   - Purposeful spring motion only (Play → progress → Running, sliding selection, surfaces growing from their trigger, the instance tile flying into the header). Everything honours Reduce Motion; nothing loops (the small running indicator pulses three times when the game starts, then rests).

## B1. Window and layout

- **Window.**
  - Minimum size 960×600. Default 1200×780.
  - `titleBarStyle: 'hiddenInset'` with `trafficLightPosition` aligned to the sidebar's top inset.
  - Vibrancy `sidebar` on the sidebar region, and a solid `windowBackground` content area.
  - The window frame, size and sidebar width are restored on relaunch.
- **Layout.** Three areas:
  - The **sidebar**: 220px by default, resizable 180–320, collapsible with ⌃⌘S.
  - The **content area**, with a toolbar row 48px tall (centred on the traffic lights). The window can be dragged from empty toolbar space.
  - An optional **inspector**: a trailing detail pane used in content lists, which can be toggled with ⌥⌘I.
- **Toolbar** (in the content area). It holds the page title (or a breadcrumb) and that page's actions, with the primary action (e.g. Play) last. Always present on the trailing side:
  - The **Activity button**, a download glyph with a small dot while work runs (red after a failure); it opens the task centre popover (B6).
  - ⌘K is opened from the sidebar's Search field; a **Search button** appears in the toolbar only while the sidebar is hidden.

## B2. Sidebar

The sidebar is a source list. From top to bottom:

0. **Search** field with a ⌘K hint. It opens the command palette, which grows out of it.
1. **Library**
   - **Home**: recent instances and updates (B3.1).
   - **Discover**: browse Modrinth and CurseForge for modpacks, mods and so on (B5).
2. **Instances**. The section header has a "+" button, which opens New Instance (⌘N).
   - Each row shows:
     - an 18px icon (or seeded dithered art) and the name, on a single 26px row
     - the Minecraft version, right-aligned in small monospaced figures (the full "1.21.1 · Fabric" label is the row's tooltip)
     - a trailing state indicator: a spinner while installing or launching, a small green dot while running, a warning badge when there's a problem
   - The selection is a grey pill that slides between rows.
   - Rows can be dragged to reorder.
   - **Folders** are disclosure groups. They are created with "New Folder" or by choosing "Move to Folder…" from a context menu. They are named only; there is no colour picker. Their expanded state is persisted.
   - **Pinned** instances appear first, in an optional "Pinned" subsection.
   - A filter field filters the list. It is hidden until invoked with ⌥⌘F or View ▸ Filter Instances, then appears under the Search field; it stays while it holds a query and hides when it loses focus empty.
   - **Instance context menu** (native):
     - Launch / Stop
     - Open in New Window: no. Amethyst is single-window, so this item is omitted.
     - Show in Finder
     - Duplicate…, which asks for a name
     - Rename
     - Change Icon…
     - Pin/Unpin
     - Move to Folder ▸
     - Export Modpack…
     - Move to Trash…
   - **Double-click** launches. **Return** opens the instance. **⌘Return** launches.
3. **Footer.** Pinned to the bottom of the sidebar, above a hairline:
   - The **Account chip**: round head avatar, name and account type. Clicking it opens the account popover:
     - a list of accounts with checkmarks
     - "Manage Accounts…", which opens Settings → Accounts
     - "Add Account…"
   - If the account is expired, the chip shows a yellow badge and the popover offers "Sign in again".

Settings is **not** a sidebar destination. It is a separate Settings window (B7), opened with ⌘, or the settings button beside the account chip.

## B3. Main views

### B3.1 Home

- **Jump back in.** A card listing up to 8 instances, most recently played first (never-played ones follow, newest first). Each row shows the icon, name, "version · loader", last played (or what the instance is doing) and an inline Play control that behaves like the sidebar's. The row opens the instance's Overview.
- **Updates.** A card shown only when there is something to update, e.g. "“Pack” has 3 mod updates". Each row deep-links to the relevant tab. The check is deferred and covers the few most recently played modded instances.
- **Empty state (no instances).** The heading "Create your first instance". Buttons: New Instance, Import Modpack…, Add Existing Folder…, Browse Modpacks.
- Not on Home: no hero, no news carousel, no draggable card grid, no focus mode, and no content counts (Home starts no folder scans).

### B3.2 Instance detail

The toolbar shows the instance icon and name, with "version · loader version · N mods" as a subtitle. On the trailing side, in order:

- **Show in Finder**
- **Activity**
- **"…" overflow:** Launch as ▸ (accounts), Launch into World ▸, Repair Files, Launch Options… (opens the Settings tab), then Export Modpack…, Duplicate…, Rename…, Change Version…, Open Logs (⌘L), Move to Trash….
- **Play**, filled with the accent. It morphs with the state: Play → a dithered progress pill showing the stage and percentage (installing: click opens Activity; launching: click cancels) → "● Running" with a stop control (click asks for confirmation; ⌥-click force quits). Its context menu repeats the launch choices.

**Tabs.** A tab strip under the toolbar, with a sliding selection pill and item counts (mods, packs, shaders, worlds). ⌘1–⌘7 switch tabs.

| # | Tab | Contents |
|---|---|---|
| 1 | **Overview** | See below |
| 2 | **Mods** | Content list (B4.1). Hidden for vanilla instances, which show an empty state offering "Add a mod loader" instead |
| 3 | **Resource Packs** | Ordered list (B4.2) |
| 4 | **Shaders** | (B4.3) |
| 5 | **Worlds** | Saves and datapacks (B4.4) |
| 6 | **Logs** | Live console and log/crash history (B3.3) |
| 7 | **Settings** | Instance settings (B3.4) |

**Overview tab** contents:

- A status line, "Ready to play", or a **Status** card with problems and fixes, for example "The game isn’t installed yet: Install", "The chosen Java runtime is missing: Use Automatic".
- A **stat strip**: play time, mods (with how many are off; modded instances), worlds, resource packs, and shaders (vanilla instances). Count cells open their tab.
- **Worlds** (the most recently played ones), **Runtime** (version, Java, memory, folder) and **Activity** (last session, total play time, created) cards.
- For modpack instances, a **Modpack** card: project, source, current version and the latest version, with "Check for Updates…" and "Version History…" (B4.7).
- No disk size and no screenshots strip.

### B3.3 Logs and crash view (instance tab 6)

- **Left list:** "Live" (the current session, only shown while the game is running) followed by past logs and crash reports grouped by date. Crash reports have a red icon.
- **Viewer toolbar:**
  - search (⌘F), with next/previous (⌘G / ⇧⌘G)
  - level filter checkboxes: Info, Warn, Error, Debug
  - "Follow tail" toggle
  - Copy all
  - Reveal in Finder
  - "Share…" (native share sheet / save as)
  - Move to Trash
- **Rendering:** monospaced (SF Mono), virtualised, with each level shown as a colour and a glyph. Repeated lines collapse with a "×N" disclosure. Timestamps are toggleable.
- **Crash view.** When the game exits abnormally:
  - The launcher brings the window forward and opens this tab, showing a **Crash summary panel** above the raw text:
    - the exit code
    - a heuristic headline, such as "Mod `X` failed to load" or "Out of memory", whenever it can be determined
    - the suspected mods as links into the Mods tab
    - buttons: Open Crash Report, Copy Report, Reveal in Finder, Relaunch
  - If the window is in the background, a native notification is posted ("Minecraft crashed: Instance X"). Clicking it opens this view.
  - A user-initiated stop is never treated as a crash.
- **Live log window.** Not a separate window by default. The instance setting "Open log window on launch" opens the Logs tab in a separate detachable window (⌥⌘L) for that process. The window is titled with the instance name, not the PID. When the game exits, it shows "Game exited (code N)" and stays readable until closed.

### B3.4 Instance settings (instance tab 7)

A grouped form in the style of macOS System Settings: inset grouped sections with label and control rows. Changes **apply immediately**; there is no staging snackbar. Exceptions:

- Changing the game version or loader goes through an explicit "Change Version…" sheet, which shows the consequences and asks for confirmation.
- Edits to free-text fields commit when the field loses focus.

Every overridable row shows "Default (from Settings)" in grey when inherited. Changing it switches the row to a local override, which has a ↺ reset button. There are no purple and blue chips.

Sections:

1. **General:** icon (click to change, or drop an image), name, notes.
2. **Version:**
   - A read-only summary, for example "Minecraft 1.21.1 · Fabric 0.16.5 · OptiFine —".
   - **Change Version…** opens the version sheet (B4.6). If mods would become incompatible, the sheet lists them and offers to update them. Mods with no update are left as they are and flagged; they are never silently disabled.
   - **Verify Files**, which shows its progress in Activity.
3. **Java:**
   - Runtime: a popup with "Automatic (recommended)", then a list of detected and managed runtimes ("Java 21.0.5 · Temurin · arm64"), then "Add from Disk…".
   - A status line with three possible outcomes:
     - "✓ Java 21 will be used".
     - "⚠ Needs Java 21 — Download".
     - "⚠ x86_64 runtime (runs under Rosetta)".
   - Memory:
     - a slider showing system RAM, with tick marks at the recommended value
     - "Automatic", on by default
     - when Automatic is off, min and max fields
4. **Launch:**
   - Resolution: width × height, or Fullscreen.
   - "Hide launcher while playing"
   - "Open log window on launch"
   - "Share options.txt with other instances"
   - Shared folders: saves, resource packs, shader packs, server list.
5. **Advanced** (collapsed by default):
   - JVM arguments
   - game arguments
   - wrapper (prepend) command
   - pre-launch command
   - environment variables (a table)
   - "Preview launch command…", which opens a sheet with a copyable, numbered argument list
6. **Modpack Info** (used for export): version, author, description, URL. It also has a "Modrinth project" field when the instance came from a pack.

The **Java issue** policy is built into the Java row. "Launch anyway" exists only in the launch-time sheet, and it applies only to that one launch. A persistent override is the explicit runtime choice in this section. No hidden whitelist.

## B4. Content management flows

### B4.1 Mods tab (template for all content tabs)

**Layout.**

- Toolbar: search (⌘F) | filter popover | "Check for Updates" | **Add Mods** (opens Discover scoped to this instance, ⇧⌘A) | "+" menu (Add from Files…, Paste URL…).
- Filter chips: All / Enabled / Disabled (one selected), plus a separate **Updates** toggle that combines with them. Updates filters on results already known from "Check for Updates" and is disabled until a check has run; the chips never check by themselves.
- A table, not a card list. Columns:
  - enable checkbox
  - icon and name, with the version underneath
  - source badge (Modrinth/CF/Local)
  - update indicator
  - side (Client/Server/Both)
  - file size
  - date added
- Columns can be sorted. Their visibility is set through the column header context menu.
- The **inspector** (Mod details) appears on the trailing side only while rows are selected; with nothing selected the table takes the full width. One selected row shows:
  - description, author and links
  - installed version, with a "Change Version…" popup
  - dependencies (each shows ✓ when satisfied, or "Install" when not)
  - dependents
  - file info: name, SHA-1 (copy), path (Reveal)
  - Enable toggle and "Move to Trash"

**Selection.** Native table selection: click, ⌘-click, ⇧-click, ⌘A, and Space to toggle enabled. Delete moves the selection to the Trash after a sheet confirmation, followed by a toast with **Undo**.

**Context menu** (same for one or many rows):

- Enable/Disable
- Update (if available)
- Show in Finder
- Open on Modrinth/CurseForge
- Copy Name
- Move to Folder ▸
- Move to Trash

**Filter popover.** Toggles with text labels:

- Show: All / Enabled / Disabled
- Has Update
- Problems (missing dependency, incompatible, duplicate)
- Source

**Problems banner.** One banner that summarises everything: "2 duplicates · 1 missing dependency · 1 incompatible — Review". It opens a **Problems sheet** with one section per type:

- Duplicates: a radio button chooses the file to keep; the rest go to the Trash.
- Missing dependencies: Install.
- Incompatible: Disable or Remove.

This replaces the separate duplicate, incompatible and dependency dialogs from the original.

**Updates.**

- "Check for Updates" shows a **Review Updates sheet**: old version → new version, a changelog disclosure, a checkbox on each row, and "Update N".
- Policy options sit in a small "Options" disclosure in the sheet:
  - preferred source
  - "Include beta/alpha"
  - "Only this Minecraft version"
- The policy is remembered per instance.

**Folders (groups).**

- Kept as user-named folders, shown as disclosure rows in the table and created with "Move to Folder ▸ New Folder…".
- There are no colours and no cross-instance "shared group rules". Those were power-user clutter; drop them.

**Unused libraries.** A row type in the Problems sheet labelled "Unused library (no mod depends on it)". The action is **Disable** or **Move to Trash**, and the label says exactly which.

**Mod loader gate.** On a vanilla instance, adding a mod opens a sheet: "Mods need a loader. Add Fabric / Quilt / Forge / NeoForge to this instance?". Each option shows its compatible version. Choosing one goes through the Change Version flow.

**OptiFine.** Shown as a special row when installed. Its inspector lets you pick the version. It can be combined with Forge.

**Drag and drop.** Dropping .jar files anywhere on the tab shows an overlay ("Add to Mods") and installs them. Dropping a modpack archive is routed to the import flow instead.

**Empty state.** "No mods yet", with buttons **Browse Mods** and **Add from Files…**.

### B4.2 Resource Packs tab

- Same table and inspector as Mods, split into two sections: **Enabled (load order)** and **Available**.
- Enabled rows have drag handles. ⌥⌘↑ / ⌥⌘↓ move the selection up or down. The top row has the highest priority, and the UI says so ("Top overrides bottom").
- A compatibility column shows a ✓ or ⚠ "Made for 1.20" (pack_format), with the reason in a tooltip.
- Folders are **not** supported, so the load order is never hidden.
- Bulk actions match Mods.

### B4.3 Shaders tab

- A table with a radio-style "Active" column. Only one shader can be active; "None" is the first row.
- If no shader loader is present when you activate one, a sheet offers: "Shaders need Iris (Fabric/Quilt/NeoForge), Oculus (Forge/NeoForge) or OptiFine". It shows only the options compatible with the instance, each with an Install button, plus "Activate anyway".

### B4.4 Worlds tab

- **Table columns:** icon, world name, game mode, last played, version, size.
- **Inspector:**
  - Properties: name, seed (copy), difficulty, cheats, game mode. Editing is behind an "Edit" button, then Save/Cancel, and is disabled while the game is running.
  - Datapacks list: enable/disable, add, Move to Trash.
  - "Play this world", which launches straight into it.
  - "Back Up", which writes a timestamped zip to the backups folder.
  - "Export…", which saves a zip through a save panel.
  - "Duplicate…"
  - "Move to Trash…"
- Dropping a world folder or zip onto the tab imports it. Dropping a datapack onto a world row imports it into that world.
- Installing a datapack from Discover uses a "Install into world" popup.
- **Advanced viewers.** These are deferred and optional: the advancement tree and the region map are not required for v1. If they are built, they go behind an "Inspect World…" button, in a separate sheet, and chunk editing is not included.

### B4.5 Instances: create, import, duplicate, delete

**New Instance sheet (⌘N).** A wide sheet with a source picker on the left:

| Source | What it does |
|---|---|
| **Custom** | Name, icon, then a **Version** section: a Minecraft version picker and a loader segmented control (None / Fabric / Quilt / Forge / NeoForge), plus an optional OptiFine checkbox. OptiFine is available on vanilla or Forge |
| **Modpack File…** | Pick a .mrpack or CurseForge .zip |
| **From URL** | Paste a Modrinth or CurseForge URL, or a direct link |
| **Existing Folder…** | Import a `.minecraft`, a Prism/MultiMC instance, a Modrinth App profile, or a CurseForge instance folder. The launcher detects the type, previews the version, loader and file counts, and offers Copy (default) or Link in place. Multiple instances found in one folder are shown as a checklist |
| **Browse Modpacks** | Jumps to Discover → Modpacks |

**Version picker.**

- A searchable list with Release selected by default, and a "Show snapshots" checkbox.
- Each loader version list shows "Recommended" and "Latest" tags. The recommended version is chosen automatically.
- The picker never silently clears a value. If the chosen value is filtered out, it stays chosen and the list shows it.
- If no loader exists for the chosen MC version, the loader option is disabled with an explanation ("Fabric isn't available for 1.5.2").

**Name.** Defaults to a unique generated name. It is validated inline for illegal filename characters (`/` and `:` on macOS) and duplicates. Problems appear as text under the field, never as a disabled button with no explanation.

**Advanced disclosure.** Java (Automatic) and memory (Automatic).

**Create.** The sheet closes, the instance appears in the sidebar showing install progress, and the instance detail opens. Installation continues in Activity. Esc or Cancel is always safe; closing the sheet never interrupts work that has already started.

**Import review.** Applies to modpack, URL and folder imports. The step before Create shows:

- the name, an icon taken from the pack, the version and loader
- a file summary ("214 mods, 12 resource packs, config")
- any files that can't be auto-downloaded, as an **Unresolved files** list with the actions: Search Modrinth/CurseForge, Download manually (opens the CF page), Skip
- If the pack matches an existing instance: "This modpack is already installed as X". Choices: **Update X** / **Create Separate Copy**.

**Duplicate…** A small sheet with Name ("X copy") and checkboxes: "Include worlds", "Include logs and screenshots" (off by default). The copy is selected when done.

**Move to Trash…** A sheet: "Move 'X' to the Trash? Its mods, worlds and settings will be moved to the Trash." Buttons: Cancel / Move to Trash (destructive). It uses the macOS Trash, so the user can recover the instance. After deletion, the selection moves to the next instance, or to Home if there are none.

**Remove from launcher (keep files)** is offered only for linked-in-place imports.

### B4.6 Change Version sheet (instance)

The same picker as in creation, plus a **Consequences** panel computed before applying:

- loader added, changed or removed
- mods that have compatible updates (pre-checked "Update them")
- mods with no compatible version (listed as "will stay installed but may not load")
- the Java requirement change ("Needs Java 21 — will download automatically")

Buttons: Cancel / Change Version.

### B4.7 Modpack update and export

- **Update modpack sheet**, opened from the Overview Modpack card or from Updates on Home:
  - A version list. Each version shows its changelog, MC version and loader, and whether it is newer or older ("Downgrade").
  - Choosing one shows a **diff review**: Added N / Removed N / Updated N / Kept N, as an expandable tree, plus a loader-change callout.
  - User-added files are preserved, and the sheet says so. Overwritten configs are backed up.
  - Buttons: Back / Update.
- **Export Modpack…** (⇧⌘E), a sheet:
  1. Format: **Modrinth (.mrpack)** or **CurseForge (.zip)**. A "Modrinth strict" option sits under Advanced.
  2. Metadata: name, version (prefilled, with a bump button), author, summary.
  3. Files: a tree with checkboxes. Sensible defaults are pre-selected (mods, config, resourcepacks, shaderpacks, options), and the sheet shows the estimated size. Mods that can be linked to Modrinth or CF are marked "Linked (not bundled)"; the rest are marked "Bundled".
  4. **Export…** opens a native save panel.
  - Progress appears in Activity. On success, a toast with "Show in Finder". On failure, an error toast with details and "Copy Details". **Failures are never silent.**
  - A "Server pack" export is optional. If built, it is a checkbox in the same sheet.

## B5. Discover (Modrinth and CurseForge)

One browser for every project type.

**Toolbar.**

- Search (⌘F).
- Type segmented control: **Modpacks · Mods · Resource Packs · Shaders · Data Packs · Worlds**.
- Source popup: All / Modrinth / CurseForge.

**Target instance.** When Discover is opened from an instance ("Add Mods"), a **target bar** appears under the toolbar: "Installing to: [Instance ▾] · 1.21.1 · Fabric", with ✕ to clear it. While a target is set, filters default to that instance's game version and loader, and every result shows its compatibility. The instance-scoped content browser replaces the original's per-page market view.

**Filter sidebar** (collapsible, closed when Discover opens; the Filters button shows it):

- sort: Relevance, Downloads, Follows, Recently Updated, Newest
- game version
- loader
- environment: client/server
- categories, merged across sources, each with a label
- "Hide installed", when a target is set

There is no per-source category switch.

**Results.** A list or grid toggle. Each item shows:

- icon, title, author, summary
- downloads, updated date, source badge
- a compatibility badge, when a target is set
- an **Install** button, whose state is Install → progress → Installed ✓ / Update

Paging uses infinite scroll with a "Load more" fallback.

**Landing (no query).** Featured/Trending for the chosen type, and "Popular for 1.21.1".

**Project page** (pushed view with a back button, ⌘[):

- Header: icon, title, author, downloads, followers, source link, and a Modrinth ↔ CurseForge switch when the project is listed on both.
- A primary **Install** button that installs the best compatible version. Its ▾ menu offers "Choose Version…".
- For modpacks: **Install** creates a new instance, and **Play** appears when the pack is already installed.
- Tabs:
  - Description (markdown).
  - Versions: filterable by game version, loader and channel. Each row has a changelog and an Install button.
  - Gallery: Quick Look-style lightbox.
  - Dependencies.
- Install summary: "Installs 1 file + 2 required dependencies", or "No version supports 1.21.1 (latest: 1.20.6)".
- The **Collections** feature is reduced to local **Favourites**, toggled with a ★ on any project. Favourites appear as a filter in Discover. Modrinth account collections are deferred.
- **Install All** for favourites is deferred.

**Paste and drop.**

- Pasting a Modrinth or CF URL (⌘V, when focus is outside a text field) or dropping a link on the window opens the right project page, or the modpack import review.
- Dropping a .mrpack or .zip on the window opens the import review directly. There is no extra "Import this?" confirmation.

**States.**

- Loading: skeleton rows.
- Offline: an "You're offline" banner with Retry, and Installed and Favourites still browsable.
- API error: an inline message with Retry, and the source that failed ("CurseForge is unavailable"). Results from the other source still show.
- Empty results: "No results for 'x'", with the button "Clear filters".

## B6. Activity (task and progress centre)

- **Entry point:** a toolbar **Activity button**, which shows a small dot while work is running (overall progress is in its accessible name). Clicking it opens a frosted **popover** about 320px wide, not a modal.
- **Rows.** Grouped as "In Progress", then "Recent".
  - Each row: title ("Installing Fabric 0.16.5 for 'Survival'") with the amount in monospaced figures ("120 MB / 340 MB" or "42%"), subtitle (the current step), a dithered progress bar, "2 min left", and a cancel button that is always visible.
  - Each row expands to show its child steps.
  - Failed rows show the error, with **Retry** and "Copy Details".
- **Footer:** "Clear Completed".
- **Placement and behaviour:**
  - Activity does not close when you navigate.
  - Progress also appears on the instance row in the sidebar, and in the Play button's progress pill.
  - Network download speed is shown only in the popover's header.
- **Dock:** the Dock icon shows a progress bar (`setProgressBar`) while downloads run. A badge counts failures.
- **Connection pool stats** are not shown. A developer-only log is available under Settings → Advanced.
- **Unresolved files and checksum failures** raise a row in Activity: "3 files need attention — Review". Clicking it opens a sheet with clear wording:
  - **Retry**.
  - **Use downloaded file anyway**, which carries a warning.
  - **Skip file**.

## B7. Settings window (⌘,)

Settings is a separate, native-style preferences window. Its sidebar of panes follows macOS System Settings. Settings has a search field: typing filters the panes and highlights matching rows.

1. **General**
   - Appearance: System / Light / Dark, plus accent colour (B8).
   - "When the game launches": Keep launcher open / Hide launcher / Quit launcher.
   - "Open log window on launch" (default).
   - "Check for problems before launch". Turning it off is the original's "fast launch".
   - Data location: the path, "Change…" (moves the data, with progress), and "Show in Finder".
   - Streamer mode, which hides usernames and emails.
2. **Accounts**
   - A list of accounts, each with the head avatar, name, type (Microsoft/Offline) and status ("Signed in" / "Session expired — Sign In").
   - +/− buttons. Removing an account asks for confirmation.
   - The selected account opens the **skin and cape editor** (B9).
3. **Appearance** (B8)
4. **Java**
   - **Installed runtimes table:** version, vendor, arch (with a ⚠ chip for x86_64), path, and source (Managed / System / Added). Managed runtimes can be removed; the rest can be forgotten.
   - **Download Java… menu:** Java 8, 17, 21 and 25, using the Mojang runtime or Zulu (see `java.md`).
   - "Automatically download required Java", on by default.
   - Refresh (re-scan).
5. **Game Defaults.** These are the defaults that each instance inherits:
   - memory: Automatic, or min/max
   - resolution
   - JVM arguments
   - game arguments
   - wrapper command
   - environment variables
6. **Network.** Proxy: System (default) / None / Manual (host, port). Maximum concurrent downloads.
7. **Privacy**
   - "Share usage data", OFF by default. An explanation lists exactly what is collected and links to a details sheet.
   - "Send crash reports", OFF by default. Covers launcher crashes only, never game logs.
   - Both toggles are the same ones shown in first run, and they take effect immediately.
8. **Updates**
   - The current version.
   - "Automatically download updates", on by default.
   - Channel: Stable / Beta.
   - "Check Now".
   - "Release notes…".
   - The state line: "Amethyst is up to date" / "Downloading 1.4.0… 42%" / "1.4.0 is ready — Restart to Update".
9. **Advanced**
   - Developer mode, which turns on verbose logs and a debug info panel.
   - "Open launcher logs folder".
   - "Copy diagnostic info" (versions, OS, arch), which copies JSON to the clipboard instead of showing it.
   - "Reset all settings…", with a confirmation.
   - Export and import settings.
10. **About:** version, licence, "Not an official Minecraft product", and acknowledgements.

The command palette hotkey is fixed at ⌘K. It can be rebound through the macOS App Shortcuts preference, but not inside the app.

## B8. Themes and backgrounds (Settings → Appearance)

- **Mode:** System / Light / Dark. The default is System, and it follows the OS live.
- **Accent colour:**
  - "Neutral" (default): the label colour, near-white in dark mode and near-black in light mode. A stored `#9b5de5` (the previous purple default) reads as Neutral.
  - Or one of 8 swatches.
  - Or "Custom…", which opens the native colour panel.
  - The accent drives buttons, selection, focus rings and progress.
- **Sidebar:**
  - "Translucent sidebar" (vibrancy), on by default. When off, the sidebar is solid.
  - Sidebar icon size: Small / Medium / Large.
- **Background:**
  - None (default) / Image / Video.
  - Image: choose a file, or "Use desktop picture". Fit: Fill / Fit.
  - Video: choose a file. It is muted by default, with a volume slider. It pauses while the game is running, while the window is hidden, and when Low Power Mode is on.
  - "Dim" slider (0–80%) and "Blur" slider. These keep text legible; the content panels stay materials, on top of the background.
  - A background can also be set per instance, in instance Settings → General → "Custom background". It replaces the original's full per-instance theme.
- **Live preview:** a thumbnail of the window.
- **Not included:**
  - the 7-colour palette editor
  - particles and halo shaders
  - background music
  - custom fonts
  - custom CSS
  - the theme store

  These are dropped as clutter. Export/import of a theme is replaced by the general settings export.
- **Accessibility:** "Reduce transparency" and "Increase contrast" from macOS are respected. When they are on, Amethyst uses solid surfaces and ignores the background.

## B9. Accounts and skins

- **Add Account sheet:**
  - Choose **Microsoft** or **Offline**.
  - **Microsoft:**
    - "Sign in with Microsoft" opens the system browser (OAuth with loopback or custom scheme). The sheet shows "Waiting for you to finish in your browser…", Cancel, and "Use a code instead". That option shows the device code in large text with Copy, and opens the verification URL.
    - There is no password field.
  - **Offline:**
    - Username, validated inline: 3–16 characters, letters, digits and underscore.
    - An optional UUID under Advanced.
    - The note "Offline accounts can't join online-mode servers".
  - Errors are shown once, inline in the sheet, using the full mapping from A12 in plain language with a help link. They are never also shown as a toast.
- **Account editor** (in Settings → Accounts):
  - Centre: a **3D skin viewer**.
    - It can be rotated by drag and zoomed by scroll.
    - An animation popup: Idle / Walk / Run / None.
    - "Show cape" toggle.
    - It pauses when not visible, and honours Reduce Motion.
  - **Skin section:**
    - The current skin.
    - Model: Classic / Slim.
    - **Change Skin…**, a menu:
      - Choose File…
      - From URL or Username…
      - From Library ▸
    - Dropping a PNG onto the viewer works too.
    - Any change is a **preview**. Nothing is uploaded until **Apply** is pressed, and **Revert** undoes the preview.
    - Invalid size is shown as an inline error.
  - **Cape section:** a row of owned capes (Microsoft) plus "None". Selecting one previews it on the viewer, and it uploads only when **Apply** is pressed, the same as for skins.
  - **Skin library:** saved skins as a grid in a popover or sheet. Each has Apply, Rename and Delete (with confirmation and undo). "Save Current Skin to Library". "Export PNG…".
  - **Offline accounts:** the skin is stored locally and used by the launcher only. A note explains this. Capes are not available.
- **Session expiry:**
  - The sidebar account chip shows a badge.
  - Launching with an expired session triggers a silent refresh. If the refresh fails, a sheet appears: "Your Microsoft session expired." Choices: **Sign In** / **Play Offline (demo)** / Cancel.
- **No accounts:** Play shows a sheet: "Add an account to play". Choices: **Add Account** / **Play Demo** / Cancel.

## B10. First-run flow

Shown once, in the main window, as a centred card on a vibrancy backdrop. Steps show a dot indicator. Back and Continue are always available.

1. **Welcome.** Logo, "Welcome to Amethyst", and one line of description. A **Get Started** button.
2. **Appearance.** Three thumbnails: System (selected) / Light / Dark. An accent swatch row, with Neutral selected by default. Changes apply live.
3. **Account.**
   - "Sign in with Microsoft" (primary), "Use an offline account", and "Skip for now".
   - Signing in uses the same sheet content as B9, inline.
   - "Skip for now" is a real skip. It is the only skip control; there is no duplicate Confirm.
4. **Java.**
   - Informational only, and automatic. The step shows "Amethyst will download the right Java for each Minecraft version automatically", with the runtimes detected on this Mac listed underneath.
   - A toggle "Download Java automatically" (on).
   - Continue.
5. **Privacy.** Heading "Help improve Amethyst". Two separate toggles, **both OFF by default**:
   - **Share usage data:** "Anonymous information about which features are used, such as launches and installs. Never includes usernames, file names or chat."
   - **Send crash reports:** "If Amethyst crashes, send a report with technical details. Game logs are never sent."

   A "Learn more…" link opens a sheet that lists the exact fields collected. The step's button reads **Continue**. Nothing is pre-checked, and continuing without changes counts as declining.

   Before this step is completed, no telemetry or crash data is sent at all. The choices can be changed later in Settings → Privacy.
6. **Done.** "You're all set". Primary **Create an Instance** (opens New Instance), secondary **Browse Modpacks** and **Import…**. "Go to Home" as a text button.

**Notes.**

- **Data location** is not asked about during first run. It defaults to `~/Library/Application Support/Amethyst`, and you can change it later in Settings → General.
- **Existing launcher data.** If the first-run scan finds data from other launchers (such as `~/Library/Application Support/minecraft` or a Prism data folder), step 6 shows an extra card: "Found 3 instances in Prism Launcher — Import…". It opens the Existing Folder import. This replaces the dropped migration wizard with a lightweight hint.
- **Interrupted run.** If the app quits during first run, it resumes at the same step. Telemetry stays off.

## B11. Notifications

There are three tiers.

1. **In-app toasts**, bottom-trailing in the content area.
   - At most 3 visible at once, stacked, with the newest on top. Older toasts are not hidden behind newer ones.
   - Kinds: success, info, warning, error. Each can carry up to two actions (for example **Undo**, **Show in Finder**, **Retry**, **Details**).
   - Info and success dismiss after 5s. Warnings and errors dismiss after 10s, and the timer pauses on hover.
   - Toasts are announced to VoiceOver through a live region.
   - Duplicates merge into "×N".
2. **Native macOS notifications.** Only sent when the window is not focused, and only for things the user cares about:
   - install or modpack finished
   - game crashed
   - update ready
   - a long download failed

   Clicking one focuses the relevant view. Each category can be switched off in macOS System Settings.
3. **Persistent issues** never live only in a toast. They appear in Activity, in the instance Overview status card, or as an inline banner, and stay until resolved. Examples:
   - database error
   - disk full
   - corrupt metadata
   - missing Java

There is no separate notification centre. The Activity popover's "Recent" section is the history.

## B12. Command palette (⌘K)

A centred floating panel, about 640px wide, with a spotlight-style input. It opens over any view.

**Empty query:**

- **Recent instances** (5). Return selects; ⌘Return launches.
- **Suggested actions:** New Instance, Import Modpack, Browse Mods for the current instance, Open Settings.

**Typing.** Fuzzy, ranked results in groups:

- **Instances:** Open, Launch, Show in Finder, Duplicate, Settings. Press → or Tab to see a sub-action list.
- **Actions.** Every menu bar command, with its shortcut shown on the right. Examples:
  - New Instance, Import Modpack, Export Modpack
  - Check for Updates, Restart to Update
  - Add Account, Switch Account ▸
  - Toggle Appearance, Open Logs, Repair Files
  - Reveal Data Folder, Clear Completed Activity
- **Settings.** Jumps to the specific pane and row, which it highlights. Toggles can be switched inline with Space.
- **Navigation:** Home, Discover, each instance's tabs ("Survival › Mods").
- **Discover.** "Search Modrinth and CurseForge for 'sodium'", shown after 2+ characters. Return opens Discover with that query. There is no inline network search in the palette, so the palette stays instant.

**Keys:**

- ↑/↓ move
- Return runs
- ⌘Return runs the secondary action (Launch)
- → or Tab drills in, ← or ⇧Tab goes back
- Esc closes, or goes back one level first
- ⌘1–9 pick the nth result

**Confirmations.** Destructive commands always go through the normal confirmation sheet. The palette never uses `prompt()` or `confirm()`.

## B13. Native menu bar

Every command here also appears in ⌘K.

**Amethyst**

| Item | Shortcut |
|---|---|
| About Amethyst | |
| Check for Updates… | Becomes **Restart to Update** when an update is ready |
| Settings… | ⌘, |
| Services | |
| Hide Amethyst | ⌘H |
| Hide Others | ⌥⌘H |
| Show All | |
| Quit Amethyst | ⌘Q. Warns if downloads are running or a game launched by the launcher is running, with the choices "Quit and keep game running" / "Cancel" |

**File**

| Item | Shortcut |
|---|---|
| New Instance… | ⌘N |
| New Folder | ⇧⌘N |
| Import Modpack… | ⌘O |
| Add Existing Folder… | ⇧⌘O |
| Import from URL… | ⌥⌘O |
| Export Modpack… | ⇧⌘E |
| Duplicate Instance… | ⌘D |
| Show in Finder | ⇧⌘R |
| Open Data Folder | |
| Move to Trash… | ⌘⌫ |
| Close Window | ⌘W |

**Edit**

| Item | Shortcut |
|---|---|
| Undo | ⌘Z. Works for trash, enable/disable and reorder |
| Redo | ⇧⌘Z |
| Cut / Copy / Paste | ⌘X / ⌘C / ⌘V. Paste accepts a modpack or project URL |
| Select All | ⌘A |
| Find | ⌘F. Searches the current list, log or Discover |
| Find Next / Find Previous | ⌘G / ⇧⌘G |
| Emoji & Symbols | |

**View**

| Item | Shortcut |
|---|---|
| Home | ⌘⇧H |
| Discover | ⌘⇧D |
| Command Palette… | ⌘K |
| Activity | ⌥⌘A |
| Instance tabs: Overview, Mods, Resource Packs, Shaders, Worlds, Logs, Settings | ⌘1–⌘7 |
| Show/Hide Sidebar | ⌃⌘S |
| Show/Hide Inspector | ⌥⌘I |
| Enter Full Screen | ⌃⌘F |

**Instance** (applies to the selected instance)

| Item | Shortcut |
|---|---|
| Play | ⌘Return |
| Play as ▸ | |
| Play into World ▸ | |
| Stop | ⌘. |
| Force Stop | ⌥⌘. |
| Add Mods… | ⇧⌘A |
| Add Files… | |
| Check for Updates | ⇧⌘U |
| Change Version… | |
| Repair Files | |
| Open Logs | ⌘L |
| Open Log Window | ⌥⌘L |
| Rename | |
| Change Icon… | |
| Pin/Unpin | |

**Account**

| Item | Shortcut |
|---|---|
| (list of accounts, radio checked) | ⌃⌘1–9 |
| Add Account… | |
| Edit Skin… | |
| Manage Accounts… | |

**Window**

| Item | Shortcut |
|---|---|
| Minimize | ⌘M |
| Zoom | |
| Main Window | ⌘0 |
| Bring All to Front | |

**Help**

| Item | Shortcut |
|---|---|
| Search | Native |
| Amethyst Help | |
| Keyboard Shortcuts | ⌘/. Opens a sheet listing every shortcut |
| Open Launcher Logs | |
| Release Notes | |
| Report an Issue… | Opens the GitHub issue page with diagnostic info copied |

Menu items are enabled or disabled to match the context. For example, the Instance menu is disabled when no instance is selected.

## B14. Auto-updater ("Restart to Update")

**Behaviour.** Checks run on launch and every 6 hours. Updates download in the background when "Automatically download" is on.

**Signals once an update is ready:**

- The menu item "Check for Updates…" becomes **"Restart to Update"**.
- A small **"Restart to Update" pill** appears in the sidebar footer, above the account chip. It is never a bare numeric badge.
- One native notification, sent only if the window is unfocused.
- One toast with the actions **Restart Now** / **Later**.

**Restart.** Restarting while a game is running asks for confirmation: "Minecraft is running. Restart Amethyst anyway? The game will keep running." If downloads are in progress, it waits or asks the user.

**If you never restart.** The update installs on the next normal quit.

**Release notes.** Rendered markdown in a sheet: version, date, notes. Buttons: Restart to Update / Later.

**Failure.** Settings → Updates shows "Couldn't download update — Retry" with details. It is never only a console message.

## B15. Keyboard and accessibility baseline

- Every interactive element can be reached with Tab when Full Keyboard Access is on. Lists use arrow keys and type-to-select.
- Every icon-only control has a tooltip, an accessible name and its shortcut.
- Focus rings are a soft halo of the accent colour.
- Contrast passes WCAG AA in both modes, including over background images, because the dim slider is enforced at a minimum when text sits over the background.
- Motion respects Reduce Motion: springs and morphs become instant (or a short crossfade), no carousels auto-advance, the running indicator does not pulse, and skin animation is paused.
- Help → Keyboard Shortcuts (⌘/) lists every shortcut.

---

# Part C: UX problems in the original and the Amethyst fix

| # | Problem in the original | Amethyst fix |
|---|---|---|
| 1 | **The same action is reachable from many places.** Logs and folder appear in header icons, the launch menu's "Manage", the settings header and the context menu. | One canonical home per action. The menu bar, the context menu and ⌘K mirror it (B0.2, B13). |
| 2 | **The launch gear opens a menu on hover and navigates on click**, and the submenus use hover delays. | Play only plays; the launch choices are click menus in "…" and on Play's context menu (B3.2). |
| 3 | **Hover-only controls:** task cancel, URL menus, skin action menu, version menu, avatar download button. | All controls are visible or clickable, with the same item in the context menu (B0.4). |
| 4 | **Destructive actions happen without confirmation:** deleting mods, packs, datapacks, logs, Java entries, saved skins, saved themes and remote collections, plus duplicate cleanup. Deleting an instance removes it from disk permanently. | Files go to the Trash, with a confirmation sheet and Undo (B0.5, B4.1, B4.5). |
| 5 | **Actions that are silent or mislabeled:** duplicate gives no feedback; "Remove unused libraries" disables the files; the store's clear-all is labelled "Cancel"; "Ignore" in the checksum dialog has a retry icon; "Javadoc" links to the update URL; the unresolved-files checkbox means "ignore". | Labels describe exactly what happens, and each action confirms its result (B4.1, B4.5, B6). |
| 6 | **Changing the MC version silently disables every mod that has no update.** | The Change Version sheet shows the consequences first. Nothing is silently disabled (B4.6). |
| 7 | **Silent failures:** modpack export errors go only to the console; the Modrinth search in the palette swallows network errors. | Errors appear in Activity and as a toast, with Copy Details (B4.7, B11). |
| 8 | **Telemetry is on by default, opt-out only, and never mentioned at first run.** | A first-run Privacy step with two separate toggles, both OFF. Nothing is sent before consent (B10.5, B7.7). |
| 9 | **The view switch (Market/Installed/Favorites) is hidden in the right pane** and disappears when you select an item. | Installed content lives in the instance tabs and browsing lives in Discover, with an explicit target-instance bar (B4.1, B5). |
| 10 | **Icon-only toolbars**, a three-state cycling icon button, and single-choice toggle groups that share one value (choosing a loader filter clears the "has update" filter). | Labelled controls and a filter popover with independent, labelled toggles (B4.1). |
| 11 | **Features are inconsistent between content pages:** bulk delete and enable exist only for Mods; Cmd-click selection only on Mods; turning on groups hides the resource pack load order. | One table and inspector model for every page, with native selection. Resource packs have no folders (B4.1–B4.3). |
| 12 | **Three separate dialogs for duplicates, incompatible mods and dependencies.** The incompatible-mods dialog can never be opened. | One Problems banner and one Problems sheet (B4.1). |
| 13 | **Instance settings use a staging snackbar** that blocks navigation and flashes red, with purple and blue Global/Local chips. | Changes apply immediately, with a grey "Default" label and a ↺ reset button. Version changes go through a sheet (B3.4). |
| 14 | **Java "Launch anyway" permanently whitelists the runtime in hidden storage.** The "No proper Java" message says to install a JRE but gives no button. | A one-time override at launch; the persistent choice is explicit in the Java row; a Download button is always available (B3.4, B7.4). |
| 15 | **The version picker silently clears a saved value** when filters change. Switching loader clears OptiFine, so OptiFine-on-Forge can't be built. | Values are never cleared silently. OptiFine is a separate checkbox that works with vanilla or Forge (B4.5). |
| 16 | **Duplicate is silent and offers no name.** Import from folder exists only inside a migration wizard with no Back button. | A Duplicate sheet with a name and options. "Existing Folder…" is a source inside New Instance (B4.5). |
| 17 | **Too many modal styles:** alert-in-card, toolbar headers and custom headers. Escape in the create dialog closes it even mid-creation, and its listener leaks. | Native-style sheets everywhere. Closing never interrupts work, because the work continues in Activity (B4.5). |
| 18 | **The Home page is a cluttered dashboard:** a draggable resizable card grid, focus mode, and an upstream panel with infinite scroll. | A simple Home (continue playing, recents, updates). The instance Overview tab holds a status card (B3.1–B3.2). |
| 19 | **The log viewer is weak:** the live window is labelled by PID, stays blank with no game, never removes tabs, can't copy or export, and has a dead hamburger icon. Crash reports are raw text. | A Logs tab with search, level filters, copy and share, plus a crash summary with suspected mods. The detachable window is titled by instance (B3.3). |
| 20 | **The task centre is a modal** that closes when you navigate and shows a developer-level Connections tab. A task-completion signal is defined but never used. | An Activity popover that persists, with Retry, Dock progress, and completion toasts and notifications (B6). |
| 21 | **Notifications show one toast at a time, newest first**, so older toasts are hidden. Errors stay forever. There is no history. Login errors appear twice. | Up to 3 stacked toasts, timed dismissal, persistent issues routed to banners or Activity, and a single error surface per flow (B11). |
| 22 | **The command palette** uses an odd default hotkey (⇧⌘C), has a tiny command list, and uses `window.prompt` and `window.confirm`. | ⌘K, with every menu command, settings deep links, navigation, and native sheets (B12). |
| 23 | **No native menu bar and no shortcut cheatsheet.** Cmd+F doesn't work on macOS (it is Ctrl only). | A full native menu bar, standard macOS shortcuts, and a ⌘/ cheatsheet (B13, B15). |
| 24 | **The update signal is a bare "1" badge on the Settings icon.** It also shows before state has loaded. There is no prompt or toast. | A "Restart to Update" pill and menu item, a toast, a notification when unfocused, and install on quit (B14). |
| 25 | **The Appearance settings are overwhelming:** 7 unlabelled colour dots with blur sliders, particles, halo, music, fonts, custom CSS, and a theme store; 4 separate URL dialogs reached by hover menus. After setup, halo is silently enabled. | System mode, an accent colour, an optional image or video with dim and blur, and the translucent sidebar. Nothing changes silently (B8). |
| 26 | **Two sidebar styles with positions, alignment, auto-hide and scale.** Clicking an instance navigates away from the current sub-page. | One native source-list sidebar. Selecting an instance keeps the current tab (B2). |
| 27 | **Accounts:** a disabled Microsoft password field; expiry shown only as red text, with no launch interception; capes save instantly while skins need Save; three routes to change a skin; the friends menu opens on hover; Offline is hidden in some regions. | Browser OAuth or device code; expiry handled at launch; preview, then Apply, for both skin and cape; one "Change Skin…" menu; Offline always available (B9). |
| 28 | **First-run setup:** Skip and Confirm do the same thing; the data folder step makes the user choose a path and drive up front. | Six clear steps, with defaults for data location and Java detected automatically (B10). |
| 29 | **Developer details shown to all users:** the raw JSON debug dump in About and the connection-pool tab. | "Copy diagnostic info" under Advanced; developer mode keeps the debug detail (B7.9). |
| 30 | **Dead or placeholder UI:** the empty Sync and Advanced instance sections, the never-shown Reset/Export settings block, commented-out creation sources, and the logger's hamburger icon. | Ship nothing that doesn't work. Every pane listed in B7 is functional. |
| 31 | **Hard-coded white text** in the delete and migration dialogs breaks light mode. Some ARIA labels and Copy/Copied are hard-coded in English. | System colours and semantic tokens. Every string comes from one string table (English-only for now), with accessible names on every control. |
| 32 | **Pasting a URL anywhere opens an import dialog.** Dropping a modpack adds an extra "Import this?" confirmation before the real dialog. | Paste is handled only when focus is outside text fields, and goes straight to the project page or import review. One review step, not two (B5). |
