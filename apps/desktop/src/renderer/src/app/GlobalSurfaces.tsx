import { lazy, Suspense, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Alert, Button, Checkbox, Kbd, Sheet, TextField } from '@/ui'
import { useInstanceActions, useInstances } from '@/data/instances'
import { router } from './router'
import { SHORTCUTS } from './commands'
import { useUi } from './ui-store'
import { CommandPalette } from './CommandPalette'

// Sheets that are rarely opened load on demand.
const NewInstanceSheet = lazy(() => import('@/routes/sheets/NewInstanceSheet'))
const AddAccountSheet = lazy(() => import('@/routes/sheets/AddAccountSheet'))

/** Surfaces mounted once per main window: palette, shortcuts, sheets and confirmations. */
export function GlobalSurfaces() {
  const newInstance = useUi((s) => s.newInstance)
  const addAccount = useUi((s) => s.addAccount)
  return (
    <>
      <CommandPalette />
      <ShortcutsSheet />
      <TrashAlert />
      <DuplicateSheet />
      <Suspense fallback={null}>
        {newInstance && <NewInstanceSheet />}
        {addAccount && <AddAccountSheet />}
      </Suspense>
    </>
  )
}

/** ⌘/: every shortcut, grouped (B13 Help → Keyboard Shortcuts, B15). */
export function ShortcutsSheet() {
  const open = useUi((s) => s.shortcuts)
  const set = useUi((s) => s.set)
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => set({ shortcuts: o })}
      title="Keyboard Shortcuts"
      width={640}
      footer={
        <Button variant="primary" onClick={() => set({ shortcuts: false })}>
          Done
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-x-8 gap-y-5">
        {SHORTCUTS.map((g) => (
          <section key={g.group} aria-label={g.group}>
            <h3 className="mb-1.5 text-small font-semibold text-label-2">{g.group}</h3>
            <dl className="flex flex-col">
              {g.items.map((s) => (
                <div key={s.label} className="flex h-6 items-center justify-between gap-3 border-b border-separator last:border-0">
                  <dt className="truncate text-body">{s.label}</dt>
                  <dd>
                    <Kbd shortcut={s.keys} className="text-label-2" />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Sheet>
  )
}

/** "Move to Trash…" confirmation for an instance (B4.5). */
function TrashAlert() {
  const target = useUi((s) => s.trash)
  const set = useUi((s) => s.set)
  const actions = useInstanceActions()
  const { data: instances = [] } = useInstances()
  return (
    <Alert
      open={!!target}
      onOpenChange={(o) => !o && set({ trash: null })}
      icon={
        <span className="flex size-12 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-red)_14%,transparent)] text-red">
          <Trash2 className="size-6" />
        </span>
      }
      title={`Move “${target?.name}” to the Trash?`}
      message="Its mods, worlds and settings will be moved to the Trash. You can restore them from the Trash in Finder."
      confirmLabel="Move to Trash"
      destructive
      onConfirm={() => {
        if (!target) return
        const idx = instances.findIndex((i) => i.id === target.id)
        const next = instances[idx + 1] ?? instances[idx - 1]
        actions.trash(target)
        set({ trash: null })
        // Selection moves to the next instance, or Home when none are left.
        if (router.state.location.pathname.includes(`/instances/${target.id}`)) {
          if (next) router.navigate({ to: '/instances/$instanceId/overview', params: { instanceId: next.id } })
          else router.navigate({ to: '/' })
        }
      }}
    />
  )
}

/** "Duplicate…" sheet: asks for a name and what to include (B4.5). */
function DuplicateSheet() {
  const target = useUi((s) => s.duplicate)
  const set = useUi((s) => s.set)
  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && set({ duplicate: null })} title={`Duplicate “${target?.name}”`} width={420}>
      {target && <DuplicateForm key={target.id} target={target} onDone={() => set({ duplicate: null })} />}
    </Sheet>
  )
}

function DuplicateForm({ target, onDone }: { target: { id: string; name: string }; onDone: () => void }) {
  const actions = useInstanceActions()
  const { data: instances = [] } = useInstances()
  const [name, setName] = useState(`${target.name} copy`)
  const [worlds, setWorlds] = useState(true)
  const [logs, setLogs] = useState(false)
  const error = !name.trim()
    ? 'Enter a name.'
    : /[/:]/.test(name)
      ? 'Names can’t contain “/” or “:”.'
      : instances.some((i) => i.name.toLowerCase() === name.trim().toLowerCase())
        ? 'An instance with this name already exists.'
        : undefined
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (error) return
        // TODO(wire): pass { includeWorlds: worlds, includeLogs: logs } to api.instances.duplicate.
        actions.duplicate(target, name.trim())
        onDone()
      }}
    >
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={error} autoFocus />
      <Checkbox checked={worlds} onCheckedChange={setWorlds} label="Include worlds" />
      <Checkbox checked={logs} onCheckedChange={setLogs} label="Include logs and screenshots" description="Off by default to keep the copy small." />
      <div className="-mx-5 -mb-4 mt-2 flex justify-end gap-2 border-t border-separator px-5 py-3">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!!error}>
          Duplicate
        </Button>
      </div>
    </form>
  )
}
