import { Sheet, toast } from '@/ui'
import { useUi } from '@/app/ui-store'
import { AccountForm } from './AccountForm'

const close = () => useUi.getState().set({ addAccount: false })

/** Add Account sheet (B9). Mounted only while `useUi().addAccount` is true. */
export default function AddAccountSheet() {
  return (
    <AccountForm
      onCancel={close}
      onDone={(a) => {
        close()
        toast({ kind: 'success', title: `Added ${a.name}` })
      }}
    >
      {({ body, actions }) => (
        <Sheet open onOpenChange={(o) => !o && close()} title="Add Account" width={460} footer={actions}>
          {body}
        </Sheet>
      )}
    </AccountForm>
  )
}
