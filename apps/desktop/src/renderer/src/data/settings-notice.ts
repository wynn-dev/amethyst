import type { SettingsNotice } from '@shared/services'
import { api } from '@/lib/rpc'
import { revealInFinder } from '@/lib/files'
import { toast } from '@/ui/toast-store'

/** The toast for a settings notice. */
export function settingsNoticeToast(n: SettingsNotice) {
  return {
    kind: 'warning' as const,
    title: n.kind === 'recovered' ? 'Your settings were restored from a backup' : 'Your settings were reset',
    message:
      n.kind === 'recovered'
        ? 'The settings file couldn’t be read, so Amethyst used the last good copy. Recent changes may be missing.'
        : 'The settings file couldn’t be read, so Amethyst is using the defaults. The damaged file was kept.',
    actions: [{ label: 'Show File', onClick: () => revealInFinder(n.corruptPath) }],
    duration: 0,
  }
}

/** Show the runtime's pending settings notice, if any. Only the first window to ask gets it. */
export async function showSettingsNotice(): Promise<void> {
  const notice = await api.settings.takeNotice().catch(() => null)
  if (notice) toast(settingsNoticeToast(notice))
}
