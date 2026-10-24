/**
 * Telemetry copy shared by first run (B10.5) and Settings → Privacy (B7.7). The field list is a
 * placeholder summary of docs/PRIVACY.md; keep the two in sync when the telemetry module lands.
 */

export const USAGE_COPY =
  'Anonymous information about which features are used, such as launches and installs. Never includes usernames, file names or chat.'

export const CRASH_COPY = 'If Amethyst crashes, send a report with technical details. Game logs are never sent.'

export const PRIVACY_FIELDS: { title: string; items: string[] }[] = [
  {
    title: 'Share usage data',
    items: [
      'An anonymous install ID, generated on this Mac and not linked to your accounts',
      'App version, macOS version and CPU architecture',
      'Feature events such as “instance created”, “game launched” or “modpack installed”',
      'Which mod loader and Minecraft version an event used',
      'Daily and monthly active use, counted with the install ID',
    ],
  },
  {
    title: 'Send crash reports',
    items: [
      'Launcher errors and crashes, with a stack trace',
      'Performance timings such as start-up time and launch time',
      'App version, macOS version and CPU architecture',
    ],
  },
  {
    title: 'Never collected',
    items: [
      'Usernames, email addresses or account tokens',
      'File names and folder paths (they are scrubbed before sending)',
      'Game logs, chat messages or world data',
      'Your IP address (discarded on receipt) and session replays',
    ],
  },
]

export const PRIVACY_FOOTNOTE =
  'Data is sent to PostHog’s EU cloud only after you turn a toggle on. Nothing is sent before you finish first run. The full policy is in PRIVACY.md in the Amethyst repository.'
