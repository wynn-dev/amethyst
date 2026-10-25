import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, Copy, ExternalLink } from 'lucide-react'
import type { MicrosoftLoginMethod } from '@shared/services'
import { Banner, Button, Segmented, Spinner, TextField, cn } from '@/ui'
import { describeError, errorCode, type FriendlyError } from '@/lib/error-messages'
import { api } from '@/lib/rpc'
import { accountActions, cancelLogin, loginMicrosoft, useAccountsStatus, useLoginStage } from '@/data/accounts'
import { patchSettings } from '@/data/settings'
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
  /** Sign in again to this existing Microsoft account. */
  reauthAccountId?: string
  onDone: (account: Account) => void
  onCancel: () => void
  /** Lays the parts out: a sheet puts actions in its footer, first run puts them under the body. */
  children: (parts: AccountFormParts) => ReactNode
}

type MsState = { step: 'start' } | { step: 'running'; method: MicrosoftLoginMethod }

function openLink(url: string) {
  void api.shell.openExternal(url).catch(() => {})
}

function ErrorBanner({ error }: { error: FriendlyError }) {
  return (
    <Banner tone="error" title={error.title} className="w-full text-left" actions={error.link ? <Button size="sm" onClick={() => openLink(error.link!)}>Learn More</Button> : undefined}>
      {error.message}
    </Banner>
  )
}

/**
 * Add Account content (B9), shared by the Add Account sheet and the first-run Account step.
 * Errors are shown once, inline. Never as a toast.
 */
export function AccountForm({ initialKind = 'microsoft', showKindPicker = true, reauthAccountId, onDone, onCancel, children }: AccountFormProps) {
  const status = useAccountsStatus()
  const stage = useLoginStage((s) => s.stage)
  const [kind, setKind] = useState<AccountKind>(reauthAccountId ? 'microsoft' : initialKind)
  const [ms, setMs] = useState<MsState>({ step: 'start' })
  const [msError, setMsError] = useState<FriendlyError>()
  const [name, setName] = useState('')
  const [uuid, setUuid] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [copied, setCopied] = useState(false)
  const [offlineError, setOfflineError] = useState<FriendlyError>()
  const [adding, setAdding] = useState(false)

  // Leaving the form aborts a sign-in that is still waiting.
  useEffect(() => () => cancelLogin(), [])

  const nameError = validateUsername(name)
  const uuidError = uuid && !UUID.test(uuid) ? 'Enter a UUID like 8667ba71-b85a-4004-af54-457a9734eed7, or leave it empty.' : undefined
  const offlineAllowed = status.data?.offlineAllowed ?? true
  const offlineValid = !!name && !nameError && !uuidError && offlineAllowed && !adding
  const msAvailable = status.data?.microsoft.available ?? true

  const addOffline = async () => {
    if (!offlineValid) return
    setAdding(true)
    setOfflineError(undefined)
    try {
      onDone(await accountActions.addOffline(name, uuid || undefined))
    } catch (e) {
      setOfflineError(describeError(e))
    } finally {
      setAdding(false)
    }
  }

  const startMicrosoft = async (method: MicrosoftLoginMethod) => {
    setMsError(undefined)
    setCopied(false)
    setMs({ step: 'running', method })
    try {
      onDone(await loginMicrosoft(method, reauthAccountId))
    } catch (e) {
      setMs({ step: 'start' })
      // A new sign-in cancels the previous one; that cancellation isn't an error to show.
      if (errorCode(e) !== 'ECANCELLED') setMsError(describeError(e))
    }
  }

  const stopMicrosoft = () => {
    cancelLogin()
    setMs({ step: 'start' })
  }

  const running = ms.step === 'running'
  const microsoftBody = (
    <div className="flex flex-col items-center gap-3 py-2 text-center" data-login-stage={running ? stage.stage : 'start'}>
      {msError && <ErrorBanner error={msError} />}
      {!msAvailable ? (
        <>
          <MicrosoftLogo />
          <p className="max-w-[360px] text-body text-label-2">
            Microsoft sign-in isn’t available in this build of Amethyst: it was built without a Microsoft app ID. Offline accounts still work for single-player.
          </p>
        </>
      ) : !running ? (
        <>
          <MicrosoftLogo />
          <p className="max-w-[340px] text-body text-label-2">
            {reauthAccountId ? 'Your session expired. Sign in again with the same Microsoft account.' : 'Sign in with the Microsoft account that owns Minecraft: Java Edition. Amethyst never sees your password.'}
          </p>
          <div className="flex gap-3 text-small">
            <Button variant="link" onClick={() => void startMicrosoft('browser')}>
              Use my browser
            </Button>
            <Button variant="link" onClick={() => void startMicrosoft('device-code')}>
              Use a code instead
            </Button>
          </div>
        </>
      ) : stage.stage === 'device-code' ? (
        <>
          <p className="text-body text-label-2">
            Go to <span className="font-medium text-label">{stage.verificationUri.replace(/^https?:\/\//, '')}</span> and enter this code:
          </p>
          <p aria-label={`Code ${stage.userCode.split('').join(' ')}`} className="selectable font-mono text-[32px] leading-10 font-semibold tracking-[0.12em]">
            {stage.userCode}
          </p>
          <div className="flex gap-2">
            <Button
              icon={<Copy />}
              onClick={() => {
                void navigator.clipboard?.writeText(stage.userCode)
                setCopied(true)
              }}
            >
              {copied ? 'Copied' : 'Copy Code'}
            </Button>
            <Button icon={<ExternalLink />} onClick={() => openLink(stage.verificationUri)}>
              Open Verification Page
            </Button>
          </div>
          <p className="flex items-center gap-1.5 text-small text-label-2">
            <Spinner size={11} /> Waiting for sign-in… The code expires at {new Date(stage.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
          </p>
        </>
      ) : stage.stage === 'browser' ? (
        <>
          <Spinner size={22} />
          <p className="text-body font-medium">Waiting for you to finish in your browser…</p>
          <div className="flex gap-3 text-small">
            <Button variant="link" onClick={() => openLink(stage.url)}>
              Open the page again
            </Button>
            <Button variant="link" onClick={() => void startMicrosoft('device-code')}>
              Use a code instead
            </Button>
          </div>
        </>
      ) : stage.stage === 'window' ? (
        <>
          <Spinner size={22} />
          <p className="text-body font-medium">Finish signing in in the Microsoft window…</p>
          <Button variant="link" className="text-small" onClick={() => void startMicrosoft('device-code')}>
            Use a code instead
          </Button>
        </>
      ) : (
        <>
          <Spinner size={22} />
          <p className="text-body font-medium">{stage.stage === 'signing-in' ? 'Signing in to Minecraft…' : 'Starting sign-in…'}</p>
        </>
      )}
    </div>
  )

  const offlineBody = (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void addOffline()
      }}
    >
      {!offlineAllowed && (
        <Banner
          tone="info"
          title="Offline accounts need a Microsoft account first"
          actions={
            <Button size="sm" onClick={() => void patchSettings({ general: { developerMode: true } })}>
              Turn On Developer Mode
            </Button>
          }
        >
          Add the Microsoft account that owns Minecraft first, or turn on Developer mode.
        </Banner>
      )}
      {offlineError && <ErrorBanner error={offlineError} />}
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
      {showKindPicker && !reauthAccountId && (
        <Segmented<AccountKind>
          aria-label="Account type"
          className="self-center"
          value={kind}
          onValueChange={(k) => {
            if (running) stopMicrosoft()
            setKind(k)
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
        <Button variant="primary" disabled={!offlineValid} onClick={() => void addOffline()}>
          {adding ? 'Adding…' : 'Add Account'}
        </Button>
      </>
    ) : !running ? (
      <>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!msAvailable} onClick={() => void startMicrosoft('window')}>
          {reauthAccountId ? 'Sign In Again' : 'Sign in with Microsoft'}
        </Button>
      </>
    ) : (
      <Button onClick={stopMicrosoft}>Cancel</Button>
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
