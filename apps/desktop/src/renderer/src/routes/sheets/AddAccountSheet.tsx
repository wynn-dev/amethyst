import { Sheet, recentTrigger, toast } from '@/ui'
import { useUi } from '@/app/ui-store'
import { AccountForm } from './AccountForm'

const close = () => useUi.getState().set({ addAccount: false, reauth: null })

/** Add Account sheet (B9). Mounted only while `useUi().addAccount` is true. */
export default function AddAccountSheet() {
  const reauth = useUi((s) => s.reauth)
  return (
    <AccountForm
      reauthAccountId={reauth ?? undefined}
      onCancel={close}
      onDone={(a) => {
        close()
        toast({ kind: 'success', title: reauth ? `Signed in as ${a.name}` : `Added ${a.name}`, message: a.active ? 'It’s used when you play.' : undefined })
      }}
    >
      {({ body, actions }) => (
        <Sheet open onOpenChange={(o) => !o && close()} title={reauth ? 'Sign In Again' : 'Add Account'} width={460} footer={actions} origin={recentTrigger}>
          {body}
        </Sheet>
      )}
    </AccountForm>
  )
}
