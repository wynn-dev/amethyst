import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { CheckCircle2, Coffee, Compass, Download, Plus, UserRound } from 'lucide-react'
import { Badge, Button, Skeleton, Switch, cn } from '@/ui'
import { FIRST_RUN_STEPS, answerPrivacy, reconcileFirstRun, useFirstRun, type FirstRunStep } from '@/data/firstRun'
import { useAppSettings, useSettingsLoaded } from '@/data/settings'
import { useAccounts } from '@/data/accounts'
import { useJavaRuntimes } from '@/data/java'
import { useAppearance, usePatchAppearance } from '@/data/appearance'
import { CRASH_COPY, USAGE_COPY } from '@/data/privacy'
import type { Account } from '@/data/types'
import { useUi } from '@/app/ui-store'
import { SkinHead } from '@/app/skin/SkinHead'
import { AmethystMark } from '@/routes/settings-window/AmethystMark'
import { AccentPicker, ModePicker } from '@/routes/settings-window/appearance-pickers'
import { PrivacyDetailsSheet } from '@/routes/settings-window/PrivacyDetails'
import { AccountForm, type AccountKind } from '@/routes/sheets/AccountForm'

const STEP_LABELS: Record<FirstRunStep, string> = {
  welcome: 'Welcome',
  appearance: 'Appearance',
  account: 'Account',
  java: 'Java',
  privacy: 'Privacy',
  done: 'Done',
}

/**
 * First run (B10): a centred card over the window's vibrancy. Progress is persisted on every step,
 * so an interrupted run resumes where it left off. No telemetry is sent before Privacy is completed.
 */
export function FirstRun() {
  const step = useFirstRun((s) => s.step)
  const setStep = useFirstRun((s) => s.setStep)
  const index = FIRST_RUN_STEPS.indexOf(step)
  const go = (delta: number) => {
    const next = FIRST_RUN_STEPS[index + delta]
    if (next) setStep(next)
  }
  // The Account step is complete only after signing in (or "Skip for now"). An existing account counts.
  const { data: accounts } = useAccounts()
  const [added, setAdded] = useState<Account>()
  const account = added ?? accounts?.find((a) => a.active)
  const [signingIn, setSigningIn] = useState<AccountKind>()
  // Privacy answers stay local until Continue: nothing is stored or sent before the step is completed.
  const [consent, setConsent] = useState({ usage: false, crashes: false })
  const [saving, setSaving] = useState(false)
  const navigate = useNavigate()

  // A data root that already answered first run (e.g. another window finished it) goes to the app.
  const loaded = useSettingsLoaded()
  const settings = useAppSettings()
  useEffect(() => {
    if (loaded && reconcileFirstRun(settings) === 'app') void navigate({ to: '/', replace: true })
  }, [loaded, settings, navigate])

  let body: ReactNode
  let primary: ReactNode = (
    <Button variant="primary" size="lg" onClick={() => go(1)}>
      Continue
    </Button>
  )
  switch (step) {
    case 'welcome':
      body = <Welcome />
      primary = (
        <Button variant="primary" size="lg" onClick={() => go(1)} autoFocus>
          Get Started
        </Button>
      )
      break
    case 'appearance':
      body = <AppearanceStep />
      break
    case 'account':
      if (signingIn) {
        return (
          <Frame index={index}>
            <AccountForm
              initialKind={signingIn}
              showKindPicker={false}
              onCancel={() => setSigningIn(undefined)}
              onDone={(a) => {
                setAdded(a)
                setSigningIn(undefined)
              }}
            >
              {({ body: form, actions }) => (
                <>
                  <StepHeader title={signingIn === 'microsoft' ? 'Sign in with Microsoft' : 'Use an offline account'} />
                  <div className="min-h-[220px]">{form}</div>
                  <Footer index={index} back={null} primary={<div className="flex gap-2">{actions}</div>} />
                </>
              )}
            </AccountForm>
          </Frame>
        )
      }
      body = <AccountStep account={account} onSignIn={setSigningIn} onSkip={() => go(1)} />
      primary = (
        <Button variant="primary" size="lg" disabled={!account} onClick={() => go(1)}>
          Continue
        </Button>
      )
      break
    case 'java':
      body = <JavaStep />
      break
    case 'privacy':
      body = <PrivacyStep consent={consent} onChange={setConsent} />
      primary = (
        <Button
          variant="primary"
          size="lg"
          disabled={saving}
          onClick={async () => {
            setSaving(true)
            const ok = await answerPrivacy(consent)
            setSaving(false)
            if (ok) go(1)
          }}
        >
          Continue
        </Button>
      )
      break
    case 'done':
      body = <DoneStep />
      primary = null
      break
  }

  return (
    <Frame index={index}>
      {body}
      <Footer
        index={index}
        back={
          index > 0 && step !== 'done' ? (
            <Button size="lg" onClick={() => go(-1)}>
              Back
            </Button>
          ) : step === 'done' ? (
            <Button size="lg" variant="borderless" onClick={() => go(-1)}>
              Back
            </Button>
          ) : null
        }
        primary={primary}
      />
    </Frame>
  )
}

function Frame({ index, children }: { index: number; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      {/* hiddenInset traffic lights sit here; the strip drags the window. */}
      <div className="drag h-[52px] shrink-0" />
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pb-[52px]">
        <main
          aria-label={`Set up Amethyst, step ${index + 1} of ${FIRST_RUN_STEPS.length}: ${STEP_LABELS[FIRST_RUN_STEPS[index]!]}`}
          className="flex w-[min(560px,100%)] animate-pop-in flex-col rounded-2xl bg-window px-10 pt-9 pb-6 shadow-sheet"
        >
          {children}
        </main>
      </div>
    </div>
  )
}

function Footer({ index, back, primary }: { index: number; back: ReactNode; primary: ReactNode }) {
  return (
    <div className="mt-8 grid grid-cols-[1fr_auto_1fr] items-center">
      <div className="justify-self-start">{back}</div>
      <ol aria-label="Progress" className="flex items-center gap-1.5">
        {FIRST_RUN_STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === index ? 'step' : undefined}
            aria-label={`${STEP_LABELS[s]}${i < index ? ', done' : i === index ? ', current' : ''}`}
            className={cn('size-[7px] rounded-full transition-colors duration-200', i === index ? 'bg-accent' : i < index ? 'bg-label-3' : 'bg-fill-3')}
          />
        ))}
      </ol>
      <div className="justify-self-end">{primary}</div>
    </div>
  )
}

function StepHeader({ title, description, icon }: { title: string; description?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col items-center text-center">
      {icon && <div className="mb-3">{icon}</div>}
      <h1 className="text-title1 font-semibold">{title}</h1>
      {description && <p className="mt-1.5 max-w-[400px] text-body text-label-2">{description}</p>}
    </div>
  )
}

function StepIcon({ children, color }: { children: ReactNode; color: string }) {
  return (
    <span className="flex size-12 items-center justify-center rounded-xl text-white [&_svg]:size-6" style={{ background: `linear-gradient(180deg, color-mix(in srgb, ${color} 80%, white), ${color})` }}>
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------------------------------ */

function Welcome() {
  return (
    <div className="flex flex-col items-center pt-4 text-center">
      <AmethystMark size={112} />
      <h1 className="mt-6 text-large font-semibold tracking-tight">Welcome to Amethyst</h1>
      <p className="mt-2 max-w-[360px] text-title3 text-label-2">A fast, native Minecraft launcher for your Mac.</p>
    </div>
  )
}

function AppearanceStep() {
  const a = useAppearance()
  const patch = usePatchAppearance()
  return (
    <>
      <StepHeader title="Choose a look" description="Changes apply right away. You can change them later in Settings." />
      <div className="flex flex-col items-center gap-7">
        <ModePicker size="lg" value={a.theme} onValueChange={(theme) => patch({ theme })} />
        <div className="flex flex-col items-center gap-2">
          <span className="text-small font-semibold text-label-2">Accent colour</span>
          <AccentPicker value={a.accentColor} onValueChange={(accentColor) => patch({ accentColor })} labels />
        </div>
      </div>
    </>
  )
}

function AccountStep({ account, onSignIn, onSkip }: { account?: Account; onSignIn: (k: AccountKind) => void; onSkip: () => void }) {
  if (account) {
    return (
      <>
        <StepHeader title="You’re signed in" icon={<SkinHead skin={account.skinUrl} hue={account.hue} size={48} />} />
        <p className="text-center text-title3">
          {account.name} <span className="text-label-2">· {account.kind === 'microsoft' ? 'Microsoft' : 'Offline'}</span>
        </p>
      </>
    )
  }
  return (
    <>
      <StepHeader
        title="Add your account"
        description="Sign in with the Microsoft account that owns Minecraft: Java Edition."
        icon={
          <StepIcon color="#007aff">
            <UserRound />
          </StepIcon>
        }
      />
      <div className="mx-auto flex w-[280px] flex-col gap-2">
        <Button variant="primary" size="lg" onClick={() => onSignIn('microsoft')}>
          Sign in with Microsoft
        </Button>
        <Button size="lg" onClick={() => onSignIn('offline')}>
          Use an offline account
        </Button>
        <Button variant="borderless" size="lg" className="text-label-2" onClick={onSkip}>
          Skip for now
        </Button>
      </div>
    </>
  )
}

function JavaStep() {
  const { data: runtimes, isPending } = useJavaRuntimes()
  return (
    <>
      <StepHeader
        title="Java is taken care of"
        description="Amethyst will download the right Java for each Minecraft version automatically, natively for Apple silicon."
        icon={
          <StepIcon color="#ff9500">
            <Coffee />
          </StepIcon>
        }
      />
      <div className="flex flex-col gap-3">
        <div className="overflow-hidden rounded-lg bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
          <p className="border-b border-separator px-3 py-1.5 text-small font-semibold text-label-2">Found on this Mac</p>
          {isPending ? (
            <div className="flex flex-col gap-2 p-3">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ) : !runtimes?.length ? (
            <p className="px-3 py-3 text-body text-label-2">No Java runtimes yet. That’s fine.</p>
          ) : (
            <ul className="max-h-[132px] divide-y divide-separator overflow-y-auto">
              {runtimes.filter((r) => r.valid).map((r) => (
                <li key={r.id} className="flex h-8 items-center gap-2 px-3 text-body">
                  <span className="tabular">Java {r.version}</span>
                  <span className="truncate text-label-2">{r.vendor}</span>
                  {r.arch === 'x86_64' && <Badge tone="warning">x86_64</Badge>}
                  {r.source === 'managed' && <Badge>Managed</Badge>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2.5 text-body shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
          <Download className="size-4 shrink-0 text-accent" /> Missing runtimes download automatically when you play. You can change this in Settings → Java.
        </p>
      </div>
    </>
  )
}

function PrivacyStep({ consent, onChange }: { consent: { usage: boolean; crashes: boolean }; onChange: (c: { usage: boolean; crashes: boolean }) => void }) {
  const [details, setDetails] = useState(false)
  return (
    <>
      <StepHeader title="Help improve Amethyst" description="Both are off unless you turn them on. Continuing without changes means no." />
      <div className="divide-y divide-separator overflow-hidden rounded-lg bg-surface shadow-[inset_0_0_0_0.5px_var(--color-surface-border)]">
        <PrivacyRow id="fr-usage" title="Share usage data" description={USAGE_COPY} checked={consent.usage} onChange={(usage) => onChange({ ...consent, usage })} />
        <PrivacyRow id="fr-crashes" title="Send crash reports" description={CRASH_COPY} checked={consent.crashes} onChange={(crashes) => onChange({ ...consent, crashes })} />
      </div>
      <p className="mt-3 text-center text-small text-label-2">
        You can change this any time in Settings → Privacy.{' '}
        <Button variant="link" className="text-small" onClick={() => setDetails(true)}>
          Learn more…
        </Button>
      </p>
      <PrivacyDetailsSheet open={details} onOpenChange={setDetails} />
    </>
  )
}

function PrivacyRow({ id, title, description, checked, onChange }: { id: string; title: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-4 px-3.5 py-3">
      <div className="flex-1">
        <label htmlFor={id} className="text-body font-medium">
          {title}
        </label>
        <p className="mt-0.5 text-small text-label-2">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function DoneStep() {
  const complete = useFirstRun((s) => s.complete)
  const navigate = useNavigate()
  const finish = (then?: () => void) => {
    complete()
    navigate({ to: '/' }).then(() => then?.())
  }
  return (
    <>
      <StepHeader
        title="You’re all set"
        description="Create your first instance, or start from a modpack."
        icon={<CheckCircle2 className="size-12 text-green" strokeWidth={1.75} />}
      />
      <div className="mx-auto flex w-[300px] flex-col gap-2">
        <Button variant="primary" size="lg" icon={<Plus />} onClick={() => finish(() => useUi.getState().set({ newInstance: true }))} autoFocus>
          Create an Instance
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button
            size="lg"
            icon={<Compass />}
            onClick={() => {
              complete()
              navigate({ to: '/discover', search: { type: 'modpack' } })
            }}
          >
            Browse Modpacks
          </Button>
          <Button size="lg" onClick={() => finish(() => useUi.getState().set({ newInstance: true, newInstanceSource: 'folder' }))}>
            Import…
          </Button>
        </div>
        <Button variant="link" className="mt-2 self-center" onClick={() => finish()}>
          Go to Home
        </Button>
      </div>
    </>
  )
}
