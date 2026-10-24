import { useState, type ReactNode } from 'react'
import { ChevronRight, Copy, ExternalLink } from 'lucide-react'
import { Banner, Button, Segmented, Spinner, TextField, cn } from '@/ui'
import { queryClient } from '@/data/query'
import type { Account } from '@/data/types'

export type AccountKind = 'microsoft' | 'offline'

const USERNAME = /^\w{3,16}$/
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

export function validateUsername(name: string): string | undefined {
  if (!name) return undefined
  if (name.length < 3) return 'Use at least 3 characters.'
  if (name.length > 16) return 'Use at most 16 characters.'
  if (!USERNAME.test(name)) return 'Use only letters, digits and underscores.'
  return undefined
}

export interface AccountFormParts {
  /** The form body. */
  body: ReactNode
  /** Footer buttons for the current state (primary last). */
  actions: ReactNode
}

export interface AccountFormProps {
  initialKind?: AccountKind
  /** Show the Microsoft / Offline switch. */
  showKindPicker?: boolean
  onDone: (account: Account) => void
  onCancel: () => void
  /** Lays the parts out: a sheet puts actions in its footer, first run puts them under the body. */
  children: (parts: AccountFormParts) => ReactNode
}

type MsState = { step: 'start' } | { step: 'browser' } | { step: 'code'; code: string }

/**
 * Add Account content (B9), shared by the Add Account sheet and the first-run Account step.
 * Errors are shown once, inline. Never as a toast.
 */
export function AccountForm({ initialKind = 'microsoft', showKindPicker = true, onDone, onCancel, children }: AccountFormProps) {
  const [kind, setKind] = useState<AccountKind>(initialKind)
  const [ms, setMs] = useState<MsState>({ step: 'start' })
  const [name, setName] = useState('')
  const [uuid, setUuid] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [copied, setCopied] = useState(false)
  // Inline error slot for the Microsoft flow (mapped from the A12 error list when wired).
  const [msError] = useState<string>()

  const nameError = validateUsername(name)
  const uuidError = uuid && !UUID.test(uuid) ? 'Enter a UUID like 8667ba71-b85a-4004-af54-457a9734eed7, or leave it empty.' : undefined
  const offlineValid = !!name && !nameError && !uuidError

  const addOffline = () => {
    if (!offlineValid) return
    // TODO(wire): api.accounts.addOffline({ name, uuid? }) → Account
    const account: Account = {
      id: `offline-${name.toLowerCase()}`,
      kind: 'offline',
      name,
      uuid: uuid || crypto.randomUUID(),
      status: 'ok',
      active: true,
      hue: (name.length * 47) % 360,
    }
    queryClient.setQueryData<Account[]>(['accounts'], (list) => [...(list ?? []).filter((a) => a.id !== account.id).map((a) => ({ ...a, active: false })), account])
    onDone(account)
  }

  const startMicrosoft = () => {
    // TODO(wire): api.accounts.loginMicrosoft({ deviceCode: false }) opens the system browser and resolves with the Account,
    // or rejects with a coded error (EXSTS_CHILD, EMC_NO_PROFILE, …) shown in `msError`.
    setMs({ step: 'browser' })
  }

  const useCode = () => {
    // TODO(wire): api.accounts.loginMicrosoft({ deviceCode: true }) → { userCode, verificationUri } then the Account.
    setMs({ step: 'code', code: 'AMTH-7Q4K' })
  }

  const microsoftBody = (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      {msError && <Banner tone="error" title={msError} className="w-full text-left" />}
      {ms.step === 'start' && (
        <>
          <MicrosoftLogo />
          <p className="max-w-[340px] text-body text-label-2">
            Sign in in your browser with the Microsoft account that owns Minecraft: Java Edition. Amethyst never sees your password.
          </p>
        </>
      )}
      {ms.step === 'browser' && (
        <>
          <Spinner size={22} />
          <p className="text-body font-medium">Waiting for you to finish in your browser…</p>
          <p className="max-w-[340px] text-small text-label-2">If the browser didn’t open, or you’d rather sign in on another device, use a code instead.</p>
          <Button variant="link" onClick={useCode}>
            Use a code instead
          </Button>
        </>
      )}
      {ms.step === 'code' && (
        <>
          <p className="text-body text-label-2">Go to microsoft.com/link and enter this code:</p>
          <p aria-label={`Code ${ms.code.split('').join(' ')}`} className="selectable font-mono text-[32px] leading-10 font-semibold tracking-[0.12em]">
            {ms.code}
          </p>
          <div className="flex gap-2">
            <Button
              icon={<Copy />}
              onClick={() => {
                navigator.clipboard?.writeText(ms.code)
                setCopied(true)
              }}
            >
              {copied ? 'Copied' : 'Copy Code'}
            </Button>
            <Button icon={<ExternalLink />} onClick={() => window.open('https://www.microsoft.com/link')}>
              Open Verification Page
            </Button>
          </div>
          <p className="flex items-center gap-1.5 text-small text-label-2">
            <Spinner size={11} /> Waiting for sign-in…
          </p>
        </>
      )}
    </div>
  )

  const offlineBody = (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        addOffline()
      }}
    >
      <TextField
        label="Username"
        placeholder="Steve"
        value={name}
        onChange={(e) => setName(e.target.value.trim())}
        error={nameError}
        hint={nameError ? undefined : '3–16 letters, digits or underscores.'}
        autoFocus
      />
      <div>
        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((a) => !a)}
          className="-ml-1 flex items-center gap-1 rounded px-1 text-body text-label-2 hover:text-label"
        >
          <ChevronRight className={cn('size-3 transition-transform duration-150', advanced && 'rotate-90')} strokeWidth={2.5} />
          Advanced
        </button>
        {advanced && (
          <TextField
            label="UUID (optional)"
            monospace
            placeholder="Generated from the username"
            value={uuid}
            onChange={(e) => setUuid(e.target.value.trim())}
            error={uuidError}
            className="mt-2"
          />
        )}
      </div>
      <p className="text-small text-label-2">Offline accounts can’t join online-mode servers.</p>
      <button type="submit" hidden />
    </form>
  )

  const body = (
    <div className="flex flex-col gap-4">
      {showKindPicker && (
        <Segmented<AccountKind>
          aria-label="Account type"
          className="self-center"
          value={kind}
          onValueChange={(k) => {
            setKind(k)
            setMs({ step: 'start' })
          }}
          options={[
            { value: 'microsoft', label: 'Microsoft' },
            { value: 'offline', label: 'Offline' },
          ]}
        />
      )}
      {kind === 'microsoft' ? microsoftBody : offlineBody}
    </div>
  )

  const actions =
    kind === 'offline' ? (
      <>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!offlineValid} onClick={addOffline}>
          Add Account
        </Button>
      </>
    ) : ms.step === 'start' ? (
      <>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={startMicrosoft}>
          Sign in with Microsoft
        </Button>
      </>
    ) : (
      <Button onClick={() => (ms.step === 'code' ? setMs({ step: 'browser' }) : setMs({ step: 'start' }))}>{ms.step === 'code' ? 'Back' : 'Cancel'}</Button>
    )

  return <>{children({ body, actions })}</>
}

function MicrosoftLogo() {
  return (
    <svg aria-hidden width="36" height="36" viewBox="0 0 23 23">
      <rect x="1" y="1" width="10" height="10" fill="#f25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
      <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
      <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
    </svg>
  )
}
