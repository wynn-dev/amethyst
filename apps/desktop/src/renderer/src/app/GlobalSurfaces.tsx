import { lazy, Suspense, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Alert, Button, Kbd, Sheet, TextField } from '@/ui'
import { libraryActions, renameInstance, useInstanceActions, useInstances } from '@/data/instances'
import { router } from './router'
import { SHORTCUTS, openInstance } from './commands'
import { useUi } from './ui-store'
import { CommandPalette } from './CommandPalette'
import { LaunchPromptSheet } from './LaunchPrompt'

// Sheets that are rarely opened load on demand.
const NewInstanceSheet = lazy(() => import('@/routes/sheets/NewInstanceSheet'))
const AddAccountSheet = lazy(() => import('@/routes/sheets/AddAccountSheet'))
const ChangeVersionSheet = lazy(() => import('@/routes/sheets/ChangeVersionSheet'))

/** Surfaces mounted once per main window: palette, shortcuts, sheets and confirmations. */
export function GlobalSurfaces() {
  const newInstance = useUi((s) => s.newInstance)
  const addAccount = useUi((s) => s.addAccount)
  const changeVersion = useUi((s) => s.changeVersion)
  return (
    <>
      <CommandPalette />
      <ShortcutsSheet />
      <TrashAlert />
      <DuplicateSheet />
      <RenameSheet />
      <NewFolderSheet />
      <RenameFolderSheet />
      <LaunchPromptSheet />
      <Suspense fallback={null}>
        {newInstance && <NewInstanceSheet />}
        {addAccount && <AddAccountSheet />}
        {changeVersion && <ChangeVersionSheet key={changeVersion.id} target={changeVersion} />}
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
  const external = instances.find((i) => i.id === target?.id)?.external
  return (
    <Alert
      open={!!target}
      onOpenChange={(o) => !o && set({ trash: null })}
      icon={
        <span className="flex size-12 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-red)_14%,transparent)] text-red">
          <Trash2 className="size-6" />
        </span>
      }
      title={external ? `Remove “${target?.name}” from Amethyst?` : `Move “${target?.name}” to the Trash?`}
      message={
        external
          ? 'It was added in place, so its folder and files stay where they are. Only Amethyst forgets it.'
          : 'Its mods and settings will be moved to the Trash. Worlds are kept in Rescued Worlds, and you can restore everything from the Trash in Finder.'
      }
      confirmLabel={external ? 'Remove' : 'Move to Trash'}
      destructive
      onConfirm={() => {
        if (!target) return
        const idx = instances.findIndex((i) => i.id === target.id)
        const next = instances[idx + 1] ?? instances[idx - 1]
        void actions.trash(target)
        set({ trash: null })
        // Selection moves to the next instance, or Home when none are left.
        if (router.state.location.pathname.includes(`/instances/${target.id}`)) {
          if (next) openInstance(next.id, 'overview')
          else void router.navigate({ to: '/' })
        }
      }}
    />
  )
}

function nameError(name: string, taken: string[], self?: string): string | undefined {
  const n = name.trim()
  if (!n) return 'Enter a name.'
  if (/[/:]/.test(n)) return 'Names can’t contain “/” or “:”.'
  if (n.length > 64) return 'Use at most 64 characters.'
  if (taken.some((t) => t.toLowerCase() === n.toLowerCase() && t !== self)) return 'An instance with this name already exists.'
  return undefined
}

function SheetFooterForm({ children, onCancel, submit, disabled }: { children: React.ReactNode; onCancel: () => void; submit: string; disabled: boolean }) {
  return (
    <>
      {children}
      <div className="-mx-5 -mb-4 mt-2 flex justify-end gap-2 border-t border-separator px-5 py-3">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={disabled}>
          {submit}
        </Button>
      </div>
    </>
  )
}

/** "Duplicate…" sheet: asks for a name (B4.5). The copy uses APFS clones, so it is near-instant. */
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
  const error = nameError(name, instances.map((i) => i.name))
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (error) return
        void actions.duplicate(target, name.trim(), (id) => openInstance(id, 'overview'))
        onDone()
      }}
    >
      <SheetFooterForm onCancel={onDone} submit="Duplicate" disabled={!!error}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={error} autoFocus />
        <p className="text-small text-label-2">Mods, worlds and settings are copied. The copy takes no extra disk space until it changes.</p>
      </SheetFooterForm>
    </form>
  )
}

/** "Rename" sheet. Managed folders are renamed to match. */
function RenameSheet() {
  const target = useUi((s) => s.rename)
  const set = useUi((s) => s.set)
  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && set({ rename: null })} title={`Rename “${target?.name}”`} width={420}>
      {target && <RenameForm key={target.id} target={target} onDone={() => set({ rename: null })} />}
    </Sheet>
  )
}

function RenameForm({ target, onDone }: { target: { id: string; name: string }; onDone: () => void }) {
  const { data: instances = [] } = useInstances()
  const [name, setName] = useState(target.name)
  const error = nameError(name, instances.map((i) => i.name), target.name)
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (error) return
        void renameInstance(target, name)
        onDone()
      }}
    >
      <SheetFooterForm onCancel={onDone} submit="Rename" disabled={!!error || name.trim() === target.name}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={error} autoFocus onFocus={(e) => e.currentTarget.select()} />
      </SheetFooterForm>
    </form>
  )
}

/** "Rename Folder…" from a folder's context menu. */
function RenameFolderSheet() {
  const target = useUi((s) => s.renameFolder)
  const set = useUi((s) => s.set)
  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && set({ renameFolder: null })} title="Rename Folder" width={400}>
      {target && <RenameFolderForm key={target.id} target={target} onDone={() => set({ renameFolder: null })} />}
    </Sheet>
  )
}

function RenameFolderForm({ target, onDone }: { target: { id: string; name: string }; onDone: () => void }) {
  const [name, setName] = useState(target.name)
  const error = !name.trim() ? 'Enter a name.' : name.trim().length > 64 ? 'Use at most 64 characters.' : undefined
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (error) return
        void libraryActions.renameFolder(target.id, name.trim())
        onDone()
      }}
    >
      <SheetFooterForm onCancel={onDone} submit="Rename" disabled={!!error || name.trim() === target.name}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={error} autoFocus onFocus={(e) => e.currentTarget.select()} />
      </SheetFooterForm>
    </form>
  )
}

/** "New Folder" sheet (optionally moving an instance into the new folder). */
function NewFolderSheet() {
  const target = useUi((s) => s.newFolder)
  const set = useUi((s) => s.set)
  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && set({ newFolder: null })} title="New Folder" width={400}>
      {target && <NewFolderForm move={target.move} onDone={() => set({ newFolder: null })} />}
    </Sheet>
  )
}

function NewFolderForm({ move, onDone }: { move?: { id: string; name: string }; onDone: () => void }) {
  const [name, setName] = useState('')
  const error = name && name.trim().length > 64 ? 'Use at most 64 characters.' : undefined
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!name.trim() || error) return
        void libraryActions.createFolder(name.trim(), move)
        onDone()
      }}
    >
      <SheetFooterForm onCancel={onDone} submit="Create" disabled={!name.trim() || !!error}>
        <TextField label="Name" placeholder="Modded" value={name} onChange={(e) => setName(e.target.value)} error={error} autoFocus />
        {move && <p className="text-small text-label-2">“{move.name}” will be moved into it.</p>}
      </SheetFooterForm>
    </form>
  )
}
