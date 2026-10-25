# Amethyst user guide

This guide covers the basics of using Amethyst. You need macOS 13 Ventura or later on a Mac with
Apple silicon.

## First run

The first time you open Amethyst, a short setup takes you through these steps:

1. **Welcome.**
2. **Appearance.** Pick a look and an accent colour. Changes apply right away, and you can change
   them later in Settings.
3. **Account.** Choose **Sign in with Microsoft**, **Use an offline account**, or
   **Skip for now**.
4. **Java.** You don't have to do anything here. Amethyst downloads the right Java for each
   Minecraft version when it needs one. This step lists any Java already on your Mac.
5. **Privacy.** Choose whether to turn on **Share usage data** and **Send crash reports**. Both
   are off. If you continue without changing them, nothing is sent. [PRIVACY.md](PRIVACY.md)
   lists exactly what each one sends.
6. **Done.** Choose **Create an Instance**, **Browse Modpacks**, **Import…**, or **Go to Home**.

To open Settings later, choose **Amethyst → Settings…** (⌘,).

## Signing in with Microsoft

To play online, sign in with the Microsoft account that owns Minecraft: Java Edition. You can do
this during first run, from **Account → Add Account…**, or in **Settings → Accounts**.

- **Sign in with Microsoft** opens a Microsoft sign-in window.
- **Use my browser** signs you in through your default browser.
- **Use a code instead** shows a code. Enter it on Microsoft's verification page, on any device,
  before the code expires.

Amethyst never sees your password. Your sign-in tokens are encrypted with the macOS Keychain.
When a session expires, Amethyst asks you to **Sign In Again**.

### "Microsoft sign-in isn't approved for this build" (awaiting Mojang approval)

Launchers made by anyone other than Mojang sign in through their own Microsoft (Azure) app.
Mojang has to approve that app before Minecraft's services accept it. Until it's approved,
sign-in fails with:

> **Microsoft sign-in isn't approved for this build.** Mojang has to approve every launcher before
> it may sign in to Minecraft, and this build's Microsoft app isn't approved yet. Offline accounts
> still work for single-player.

Your account isn't the problem, so you don't need to change anything on it. Builds made without
a Microsoft app ID say "Microsoft sign-in isn't available in this build of Amethyst" instead.

Other sign-in problems also have their own messages. For example, "This account doesn't own
Minecraft: Java Edition" or "This Microsoft account has no Xbox profile". Each message tells you
what to do next.

## Offline accounts

Offline accounts let you play single-player under any name. They can't join online-mode servers.
To add one, choose **Offline** in the Add Account sheet, then enter a **Username**. It must be 3
to 16 characters, using only letters, digits and underscores. You can also enter a
**UUID (optional)**. If you leave it empty, Amethyst generates one from the username.

You can add offline accounts once either of these is true:

- **You've added a Microsoft account.** Add the Microsoft account that owns Minecraft first.
- **Developer mode is on.** Click **Turn On Developer Mode** in the Add Account sheet, or turn on
  **Settings → Advanced → Developer mode**. Developer mode also shows raw error details.

## Creating instances and installing modpacks

An instance is a separate copy of the game. Each one has its own mods, resource packs, shader
packs, worlds and settings. Choose **File → New Instance…** (⌘N) to create one. The New Instance
sheet gives you these options:

- **Custom.** Choose a Minecraft version (tick **Show snapshots** to see those too) and a mod
  loader: Vanilla, Fabric, Quilt, Forge or NeoForge. You can also choose the loader version, the
  Java runtime and the memory.
- **Modpack File….** Choose a Modrinth `.mrpack` or a CurseForge `.zip`. You can review the
  version, the loader and the files before anything is installed. You can also drop a modpack
  file anywhere in the main window, or use **File → Import Modpack…** (⌘O).
- **From URL.** Paste a Modrinth modpack link, such as
  `https://modrinth.com/modpack/fabulously-optimized`, or an `https://` link to a `.mrpack` or
  `.zip` file. CurseForge project links can't be opened this way yet. Find those modpacks in
  Discover instead.
- **Existing Folder….** Import a `.minecraft` folder or another launcher's instance folder.
  **Copy into Amethyst** is the default. On APFS the copy takes no extra disk space. **Link in
  place** keeps the files where they are.
- **Browse Modpacks.** This opens **Discover**.

**Discover** (**View → Discover**, ⇧⌘D) lets you search Modrinth and CurseForge for modpacks,
mods, resource packs, shaders, data packs and worlds. Use the **Source** menu to pick **All
Sources** or just one site. If you open Discover from an instance, the bar at the top shows
"Installing to:" and the instance that installs go into. You can pick a different instance
there. Builds made without a CurseForge API key show Modrinth results only.

## Missing files (CurseForge)

Some CurseForge authors don't allow launchers to download their files. When a modpack contains
files like that, Amethyst never tries to work around it. It shows a dialog titled
"N files must be downloaded by hand" instead:

1. Click **Download Page** next to a file. The file's CurseForge page opens in your browser.
   Download the file from there.
2. While the dialog is open, Amethyst watches your `~/Downloads` folder ("Watching Downloads…").
   It picks up each file as soon as the download finishes.
3. If you saved a file somewhere else, drop it on the dialog or click **Choose Files…**.

Each file is checked against the modpack before Amethyst uses it. When every file is in place,
the dialog says "All files are in place". Click **Finish Later** to close the dialog before then.

## Java

You normally don't need to think about Java. When you click Play, Amethyst downloads the Java
version that Minecraft version needs, built natively for Apple silicon. It uses Mojang's own Java
runtimes where Mojang provides an Apple silicon build. Otherwise, such as for Java 8 and Java 16,
it uses **Azul Zulu**. Every download is checked against its published checksum.

To choose a Java yourself, open **Settings → Java**:

- **Java selection** offers **Automatic (recommended)**, **Prefer installed Java** (use a
  compatible arm64 JDK already on your Mac first), or **Always use one runtime**.
- **Add…** adds a Java installation that Amethyst didn't find on its own. In a runtime's actions
  menu, **Use for Every Instance** makes it the default.

To use a different Java for just one instance, open that instance's **Settings** tab and change
**Runtime**.

## World backups

Open an instance's **Worlds** tab and select a world. Its backups appear in the inspector.

- **Back Up** saves a zip of the world.
- **Automatic backups.** Before you change an instance's Minecraft version or update its modpack,
  Amethyst backs up every world in that instance first. These backups are marked **Auto**. You
  can turn this off in **Settings → General → Back up worlds before version and modpack changes**.
  Amethyst keeps 5 automatic backups per world by default. You can change the number in the same
  place. **Clean Up Old Automatic Backups** deletes the extras.
- **Restore…** offers **Restore as a Copy**, which adds the backup as a new world, and **Restore
  and Replace…**, which moves the current world to the Trash first so you can still get it back.
  You can also choose **Delete Backup**.

## Where your data lives

Everything Amethyst stores is in `~/Library/Application Support/Amethyst`. To open that folder,
choose **File → Open Data Folder**. These are the main folders:

| Folder | Contents |
|---|---|
| `instances/` | Your instances. Each one is a normal Minecraft game folder with `mods/`, `saves/`, `resourcepacks/` and so on |
| `minecraft/` | Game versions, libraries and assets that all instances share |
| `runtimes/` | Java runtimes that Amethyst downloaded |
| `store/` | Mods and packs, stored once and shared between instances (don't edit this by hand) |
| `backups/` | World backups, per instance and world |
| `rescued-worlds/` | Worlds moved out of instances you deleted |
| `cache/` | Caches that are safe to delete while Amethyst isn't running |

Account details are in `accounts.json`, but the Microsoft tokens are not. They are encrypted
separately in `secrets/`. Instances you imported with **Link in place** stay where they are.
[STORAGE.md](STORAGE.md) describes the full layout.

## Reporting bugs

If something goes wrong:

1. Choose **Help → Open Launcher Logs**. The launcher's logs are in `~/Library/Logs/Amethyst`.
2. If the problem is with the game itself, open the instance's **Logs** tab (⌘L). It shows the
   game log and, after a crash, the crash report. **Reveal in Finder** shows the log file, and
   **Copy All** copies the log text. Older logs are in the instance's `logs/` folder.
3. **Settings → Advanced → Diagnostic info → Copy** copies version and system details.
4. Open an issue at <https://github.com/wynn-dev/amethyst/issues/new> (or choose
   **Help → Report an Issue…**). Describe what you did and what happened, and attach the logs.
   Before you post a log, check it for anything you don't want to share, such as your username.
