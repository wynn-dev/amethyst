import type { ReactNode } from 'react'
import { AlertTriangle, Coffee, Cpu, KeyRound, UserRound, XOctagon } from 'lucide-react'
import { Button, Sheet, cn, recentTrigger } from '@/ui'
import { describeError } from '@/lib/error-messages'
import { closeLaunchPrompt, installJavaAndLaunch, launchInstance, useLaunchPrompt, type LaunchPrompt } from '@/data/launch'
import { useUi } from './ui-store'
import { copyToClipboard } from './clipboard'

/** A plain line icon: muted for information, yellow-orange for warnings, red for errors. No tile. */
function Glyph({ children, tone }: { children: ReactNode; tone: 'muted' | 'orange' | 'red' }) {
  return (
    <span aria-hidden className={cn('flex size-5 shrink-0 items-center justify-center [&_svg]:size-[18px] [&_svg]:stroke-[1.5]', { muted: 'text-label-2', orange: 'text-orange', red: 'text-red' }[tone])}>
      {children}
    </span>
  )
}

interface View {
  icon: ReactNode
  title: string
  body: ReactNode
  actions: ReactNode
}

function view(p: LaunchPrompt): View {
  const set = useUi.getState().set
  const cancel = <Button onClick={closeLaunchPrompt}>Cancel</Button>
  switch (p.kind) {
    case 'no-account':
      return {
        icon: (
          <Glyph tone="muted">
            <UserRound />
          </Glyph>
        ),
        title: 'Add an account to play',
        body: 'Minecraft needs a player. Sign in with the Microsoft account that owns Minecraft: Java Edition, or add an offline account for single-player.',
        actions: (
          <>
            {cancel}
            <Button
              variant="primary"
              onClick={() => {
                closeLaunchPrompt()
                set({ addAccount: true })
              }}
            >
              Add Account…
            </Button>
          </>
        ),
      }
    case 'java-required':
      return {
        icon: (
          <Glyph tone="orange">
            <Coffee />
          </Glyph>
        ),
        title: `“${p.instance.name}” needs Java ${p.major || ''}`.trim(),
        body: `No suitable Java ${p.major} is installed and it couldn’t be downloaded automatically. Amethyst can download a native Apple silicon runtime now (Mojang’s build when there is one, otherwise Azul Zulu). The game starts when it’s done.`,
        actions: (
          <>
            {cancel}
            <Button variant="primary" disabled={!p.major} onClick={() => void installJavaAndLaunch(p.instance, p.major, p.options)}>
              Download Java {p.major}
            </Button>
          </>
        ),
      }
    case 'natives-unavailable':
      return {
        icon: (
          <Glyph tone="orange">
            <Cpu />
          </Glyph>
        ),
        title: 'This version can’t run on Apple silicon yet',
        body: (
          <>
            <p>
              Amethyst runs every Minecraft version natively on Apple silicon and never falls back to Rosetta. The native libraries this version needs haven’t been
              published for arm64 yet, so it can’t start. Newer versions work.
            </p>
            <p className="selectable mt-2 rounded-md px-2 py-1.5 font-mono text-[11px] text-label-2 hairline">{p.message}</p>
          </>
        ),
        actions: (
          <>
            <Button
              onClick={() => {
                closeLaunchPrompt()
                set({ changeVersion: p.instance })
              }}
            >
              Change Version…
            </Button>
            <Button variant="primary" onClick={closeLaunchPrompt}>
              OK
            </Button>
          </>
        ),
      }
    case 'sign-in':
      return {
        icon: (
          <Glyph tone="orange">
            <KeyRound />
          </Glyph>
        ),
        title: 'Your Microsoft session expired',
        body: 'Sign in again to play. Your settings and skins are kept.',
        actions: (
          <>
            {cancel}
            <Button
              variant="primary"
              onClick={() => {
                closeLaunchPrompt()
                set({ addAccount: true, reauth: p.accountId ?? null })
              }}
            >
              Sign In…
            </Button>
          </>
        ),
      }
    case 'msa-not-approved': {
      const f = describeError({ code: 'EMSA_APP_NOT_APPROVED' })
      return {
        icon: (
          <Glyph tone="orange">
            <AlertTriangle />
          </Glyph>
        ),
        title: f.title,
        body: f.message,
        actions: (
          <>
            <Button
              onClick={() => {
                closeLaunchPrompt()
                set({ addAccount: true })
              }}
            >
              Use an Offline Account…
            </Button>
            <Button variant="primary" onClick={closeLaunchPrompt}>
              OK
            </Button>
          </>
        ),
      }
    }
    case 'error':
      return {
        icon: (
          <Glyph tone="red">
            <XOctagon />
          </Glyph>
        ),
        title: `“${p.instance.name}” couldn’t start`,
        body: (
          <>
            <p className="font-medium text-label">{p.title}</p>
            {p.message && p.message !== p.title && <p className="mt-1">{p.message}</p>}
          </>
        ),
        actions: (
          <>
            <Button variant="borderless" onClick={() => copyToClipboard(p.details, 'Copied details')}>
              Copy Details
            </Button>
            <Button
              onClick={() => {
                closeLaunchPrompt()
                void launchInstance(p.instance)
              }}
            >
              Try Again
            </Button>
            <Button variant="primary" onClick={closeLaunchPrompt}>
              OK
            </Button>
          </>
        ),
      }
  }
}

/** The launch-time sheet for typed failures (B9 session expiry, no account, Java, natives). */
export function LaunchPromptSheet() {
  const prompt = useLaunchPrompt((s) => s.prompt)
  const v = prompt ? view(prompt) : undefined
  return (
    <Sheet open={!!prompt} onOpenChange={(o) => !o && closeLaunchPrompt()} title={v?.title ?? ''} hideTitle width={440} footer={v?.actions} origin={recentTrigger}>
      {v && (
        <div className="flex items-start gap-3" data-launch-prompt={prompt?.kind}>
          <div className="pt-px">{v.icon}</div>
          <div className="min-w-0 flex-1">
            <h2 className="text-headline font-semibold">{v.title}</h2>
            <div className="mt-1 text-compact text-label-2">{v.body}</div>
          </div>
        </div>
      )}
    </Sheet>
  )
}
