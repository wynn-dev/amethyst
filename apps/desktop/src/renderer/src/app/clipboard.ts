import { toast } from '@/ui/toast-store'

/** Copies text and confirms it, or says why it couldn't. */
export function copyToClipboard(text: string, what = 'Copied'): void {
  if (!navigator.clipboard) {
    toast({ kind: 'error', title: 'Couldn’t copy', message: 'The clipboard isn’t available.' })
    return
  }
  navigator.clipboard.writeText(text).then(
    () => toast({ kind: 'success', title: what }),
    () => toast({ kind: 'error', title: 'Couldn’t copy', message: 'The clipboard isn’t available.' }),
  )
}
