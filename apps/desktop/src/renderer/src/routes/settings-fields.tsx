import { useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { Button, IconButton, TextArea, TextField, cn } from '@/ui'
import { ENV_NAME } from '@/lib/args'

/** A text field that commits when it loses focus (or on Return). */
export function CommitField({
  value,
  onCommit,
  multiline,
  ...rest
}: { value: string; onCommit: (v: string) => void; multiline?: boolean; placeholder?: string; 'aria-label': string; monospace?: boolean; className?: string; id?: string; error?: string }) {
  const commit = (v: string) => v !== value && onCommit(v)
  if (multiline)
    return <TextArea key={value} defaultValue={value} onBlur={(e) => commit(e.target.value)} rows={2} {...rest} className={cn('w-full', rest.className)} />
  return (
    <TextField
      key={value}
      defaultValue={value}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      {...rest}
    />
  )
}

/** Environment variables as editable rows; names are validated like the runtime does. */
export function EnvTable({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [draft, setDraft] = useState<{ key: string; value: string } | null>(null)
  const rows = Object.entries(value)
  const set = (entries: [string, string][]) => onChange(Object.fromEntries(entries.filter(([k]) => ENV_NAME.test(k))))
  const draftError = draft?.key && !ENV_NAME.test(draft.key) ? 'Names use letters, digits and _, and don’t start with a digit.' : undefined
  return (
    <div className="flex w-full flex-col gap-1.5">
      {rows.length === 0 && !draft && <p className="text-small text-label-3">No variables.</p>}
      {rows.map(([k, v], i) => (
        <div key={k} className="flex items-center gap-1.5">
          <CommitField monospace aria-label={`Variable ${i + 1} name`} value={k} onCommit={(key) => ENV_NAME.test(key) && set(rows.map(([a, b]) => (a === k ? [key, b] : [a, b])))} className="w-[160px]" />
          <span className="text-label-3">=</span>
          <CommitField monospace aria-label={`Variable ${i + 1} value`} value={v} onCommit={(nv) => set(rows.map(([a, b]) => (a === k ? [a, nv] : [a, b])))} className="flex-1" />
          <IconButton label={`Remove ${k}`} size="sm" onClick={() => set(rows.filter(([a]) => a !== k))}>
            <Minus />
          </IconButton>
        </div>
      ))}
      {draft && (
        <div className="flex items-start gap-1.5">
          <TextField monospace aria-label="New variable name" placeholder="NAME" value={draft.key} error={draftError} onChange={(e) => setDraft({ ...draft, key: e.target.value })} className="w-[160px]" autoFocus />
          <span className="pt-1 text-label-3">=</span>
          <TextField
            monospace
            aria-label="New variable value"
            placeholder="value"
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.key && !draftError) {
                set([...rows, [draft.key, draft.value]])
                setDraft(null)
              }
            }}
            className="flex-1"
          />
          <Button
            size="sm"
            disabled={!draft.key || !!draftError}
            onClick={() => {
              set([...rows, [draft.key, draft.value]])
              setDraft(null)
            }}
          >
            Add
          </Button>
        </div>
      )}
      {!draft && (
        <Button size="sm" variant="borderless" icon={<Plus />} className="-ml-2 self-start" onClick={() => setDraft({ key: '', value: '' })}>
          Add Variable
        </Button>
      )}
    </div>
  )
}
