import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileDown } from 'lucide-react'
import type { ResourceDetail, ResourceKind, ResourceRow } from '@shared/services'
import { Alert, Button, Checkbox, EmptyState, SearchField, Select, Sheet, Skeleton, Spinner, VirtualList, cn } from '@/ui'
import { BlockIcon, formatBytes, formatDate } from '@/app/visuals'
import { KIND_NOUN, addFromInstance, noun, queryHash, resourceKeys, useResourceAll, type ListQuery, type PagedList } from '@/data/content'
import { useInstanceRows, runtimeLabel } from '@/data/instance-info'
import { dragHasFiles, droppedPaths, revealInFinder } from '@/lib/files'
import { api } from '@/lib/rpc'
import { CopyButton, InspectorSection, PropertyList } from './parts'

/* ------------------------------------------------------------------------------------------ */
/* Rows                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** A row slot whose page hasn't loaded yet. */
export interface Placeholder {
  placeholder: true
  id: string
  index: number
}
export type ContentRow = ResourceRow | Placeholder
export const isPlaceholder = (r: ContentRow): r is Placeholder => 'placeholder' in r

/** Rows for a VirtualTable: loaded rows, and placeholders that load their page when rendered. */
export function useTableRows(list: PagedList): ContentRow[] {
  return useMemo(() => list.rows.map((r, index) => r ?? { placeholder: true as const, id: `\u0000p${index}`, index }), [list.rows])
}

/** Real row ids of a selection (placeholders can be swept up by ⌘A). */
export const realIds = (ids: Iterable<string>) => [...ids].filter((id) => !id.startsWith('\u0000p'))

/** Rendered inside a placeholder row: asks for its page once, shows a skeleton line. */
export function PlaceholderCell({ index, request }: { index: number; request: (i: number) => void }) {
  useEffect(() => request(index), [index, request])
  return (
    <div className="flex items-center gap-[9px]" aria-hidden>
      <Skeleton className="size-[18px] rounded-[5px]" />
      <Skeleton className="h-2 w-36" />
    </div>
  )
}

export function hueOf(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

/** The file's own icon (served by `amethyst-asset:`), or a generated block. */
export function ResourceIcon({ row, size = 18 }: { row: Pick<ResourceRow, 'id' | 'name' | 'iconUrl'>; size?: number }) {
  return <BlockIcon hue={hueOf(row.id)} label={row.name} size={size} src={row.iconUrl ?? undefined} className="[image-rendering:pixelated]" />
}

const SOURCE_NAME = { modrinth: 'Modrinth', curseforge: 'CurseForge', local: 'Local' } as const

/** Where a file came from, as quiet text (no coloured badge). */
export function RowSource({ row }: { row: ResourceRow }) {
  return <span className="truncate text-meta text-label-2">{SOURCE_NAME[row.source?.platform ?? 'local']}</span>
}

const shortDateFmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })
const yearDateFmt = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' })
/** A compact date for table cells: "Oct 24" this year, "Oct 2024" before. */
export function shortDate(ts: number, now = Date.now()): string {
  return new Date(ts).getFullYear() === new Date(now).getFullYear() ? shortDateFmt.format(ts) : yearDateFmt.format(ts)
}

/**
 * How many rows match a query, without loading them (filter chip counts). Cached under the
 * kind's page keys, so the change events that refresh the table refresh it too.
 */
export function useResourceCount(instanceId: string, kind: ResourceKind, query: ListQuery, enabled = true): number | undefined {
  const q = queryHash(query)
  const count = useQuery({
    queryKey: [...resourceKeys.pages(instanceId, kind), q, 'count'],
    queryFn: async () => (await api.resources.list(instanceId, kind, { ...query, offset: 0, limit: 1 })).total,
    enabled: !!instanceId && enabled,
    placeholderData: (prev: number | undefined) => prev,
  })
  return count.data
}

/**
 * The compact filter bar above a content table (the mockup's `.fbar`): filter field, chips and
 * counts on the left, the tab's actions on the right.
 */
export function ContentBar({ children, trailing }: { children?: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-separator pr-3 pl-4">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
      {trailing && <div className="flex shrink-0 items-center gap-1.5">{trailing}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Drag and drop                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * Accept files dropped anywhere on a tab. The handler decides what each path is; the window-level
 * modpack drop never sees drops the tab handled.
 */
export function useFileDrop(onPaths: (paths: string[]) => void) {
  const [active, setActive] = useState(false)
  const depth = useRef(0)
  const props = {
    onDragEnter: (e: DragEvent) => {
      if (!dragHasFiles(e)) return
      e.preventDefault()
      depth.current++
      setActive(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!dragHasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e: DragEvent) => {
      if (!dragHasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    },
    onDrop: (e: DragEvent) => {
      if (!dragHasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current = 0
      setActive(false)
      const paths = droppedPaths(e.dataTransfer)
      if (paths.length) onPaths(paths)
    },
  }
  return { active, props }
}

export function DropOverlay({ active, label, hint }: { active: boolean; label: string; hint?: string }) {
  if (!active) return null
  return (
    <div className="pointer-events-none absolute inset-2 z-20 flex animate-fade-in flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-separator-2 glass">
      <FileDown className="mb-1 size-6 text-label-2" strokeWidth={1.5} />
      <p className="text-headline font-semibold text-label">{label}</p>
      {hint && <p className="text-meta text-label-2">{hint}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Inspector pieces                                                                           */
/* ------------------------------------------------------------------------------------------ */

export function FileSection({ row, detail }: { row: ResourceRow; detail?: ResourceDetail }) {
  return (
    <InspectorSection title={row.isDirectory ? 'Folder' : 'File'}>
      <PropertyList
        rows={[
          { label: 'Name', value: <span className="selectable mono break-all">{row.fileName}</span> },
          ...(row.isDirectory ? [] : [{ label: 'Size', value: <span className="mono">{formatBytes(row.size)}</span> }]),
          ...(row.mtimeMs ? [{ label: 'Modified', value: <span className="mono">{formatDate(row.mtimeMs)}</span> }] : []),
          ...(row.sha1
            ? [
                {
                  label: 'SHA-1',
                  value: (
                    <span className="inline-flex items-center gap-1">
                      <span className="selectable mono">{row.sha1.slice(0, 12)}…</span>
                      <CopyButton text={row.sha1} label="Copy SHA-1" />
                    </span>
                  ),
                },
              ]
            : []),
          { label: 'Source', value: <RowSource row={row} /> },
        ]}
      />
      <Button size="sm" variant="borderless" className="mt-2 -ml-2" disabled={!detail?.path} onClick={() => revealInFinder(detail?.path)}>
        Reveal in Finder
      </Button>
    </InspectorSection>
  )
}

export function ProblemNote({ row }: { row: ResourceRow }) {
  if (!row.problem) return null
  return (
    <p className="mt-2 text-callout text-orange" title={row.problem.message}>
      {row.problem.code === 'not-a-pack' ? 'Not a valid pack' : row.problem.code === 'nested-too-deep' ? 'Packed one folder too deep' : 'The file is damaged or unreadable'}: {row.problem.message}
    </p>
  )
}

export function ScanningNote({ scanning }: { scanning: boolean }) {
  if (!scanning) return null
  return (
    <span className="flex items-center gap-1.5 text-meta text-label-2" role="status">
      <Spinner size={11} /> Reading files…
    </span>
  )
}

/** The "N mods · M selected" count in the sub-toolbar. */
export function CountLabel({ kind, total, all, selected }: { kind: ResourceKind; total: number; all?: number; selected: number }) {
  return (
    <span className="pl-1.5 font-mono text-[11px] text-label-3 tabular">
      {all !== undefined && all !== total ? `${total} of ${noun(kind, all)}` : noun(kind, total)}
      {selected > 1 && ` · ${selected} selected`}
    </span>
  )
}

/** "Move to Trash?" confirmation, shared by every tab. */
export function TrashConfirm({ kind, pending, label, onCancel, onConfirm }: { kind: ResourceKind; pending: string[] | null; label?: string; onCancel: () => void; onConfirm: (ids: string[]) => void }) {
  return (
    <Alert
      open={!!pending}
      onOpenChange={(o) => !o && onCancel()}
      title={pending?.length === 1 && label ? `Move “${label}” to the Trash?` : `Move ${noun(kind, pending?.length ?? 0)} to the Trash?`}
      message="You can undo this, or put the files back from the Trash in Finder."
      confirmLabel="Move to Trash"
      destructive
      onConfirm={() => pending && onConfirm(pending)}
    />
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Add from another instance…                                                                 */
/* ------------------------------------------------------------------------------------------ */

export function AddFromInstanceSheet({ open, onOpenChange, instanceId, kind }: { open: boolean; onOpenChange: (o: boolean) => void; instanceId: string; kind: ResourceKind }) {
  const { data: instances = [] } = useInstanceRows()
  const others = instances.filter((i) => i.id !== instanceId && i.state === 'ok')
  const [from, setFrom] = useState<string | undefined>(undefined)
  const source = from ?? others[0]?.id
  const rows = useResourceAll(source ?? '', kind, {}, open && !!source)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (rows.data ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.fileName.toLowerCase().includes(q))
  }, [rows.data, query])
  const [one, many] = KIND_NOUN[kind]

  const toggle = (id: string, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Add ${many} from Another Instance`}
      description={`Copies are stored once on disk and cloned into this instance. Each instance keeps its own ${many}.`}
      width={560}
      footerLeading={visible.length > 0 ? <span className="text-meta text-label-2 tabular">{picked.size ? `${picked.size} selected` : `${visible.length} ${visible.length === 1 ? one : many}`}</span> : undefined}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!source || picked.size === 0 || busy}
            onClick={async () => {
              if (!source) return
              setBusy(true)
              await addFromInstance(instanceId, kind, source, [...picked])
              setBusy(false)
              setPicked(new Set())
              onOpenChange(false)
            }}
          >
            {busy ? 'Adding…' : picked.size ? `Add ${noun(kind, picked.size)}` : 'Add'}
          </Button>
        </>
      }
    >
      {others.length === 0 ? (
        <EmptyState title="No other instances" description={`Create another instance first, then you can copy its ${many} here.`} className="py-8" />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Select
              aria-label="Instance"
              value={source ?? ''}
              onValueChange={(v) => {
                setFrom(v)
                setPicked(new Set())
              }}
              options={others.map((i) => ({ value: i.id, label: `${i.name} (${runtimeLabel(i)})`, text: i.name }))}
              className="min-w-0 flex-1"
            />
            <SearchField value={query} onValueChange={setQuery} placeholder={`Search ${many}`} className="w-[180px]" />
          </div>
          {rows.isPending ? (
            <div className="flex h-[300px] items-center justify-center">
              <Spinner label="Loading" />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState title={query ? `No ${many} match “${query}”` : `That instance has no ${many}`} className="h-[300px]" />
          ) : (
            <>
              <Checkbox
                label="Select all"
                checked={picked.size === 0 ? false : picked.size === visible.length ? true : 'indeterminate'}
                onCheckedChange={(on) => setPicked(on ? new Set(visible.map((r) => r.id)) : new Set())}
              />
              <VirtualList
                items={visible}
                rowHeight={32}
                getKey={(r) => r.id}
                aria-label={`${many} in the other instance`}
                className={cn('h-[300px] rounded-[10px] border border-separator')}
                renderRow={(r) => (
                  <label className="flex h-full cursor-default items-center gap-[9px] border-b border-separator px-3 hover:bg-hover">
                    <Checkbox checked={picked.has(r.id)} onCheckedChange={(on) => toggle(r.id, on)} aria-label={`Add ${r.name}`} />
                    <ResourceIcon row={r} />
                    <span className="min-w-0 flex-1 truncate text-compact">{r.name}</span>
                    <span className="truncate mono text-label-2">{r.version || (r.isDirectory ? 'Folder' : formatBytes(r.size))}</span>
                  </label>
                )}
              />
            </>
          )}
        </div>
      )}
    </Sheet>
  )
}

/** A centered empty state with optional actions, used when a folder has nothing yet. */
export function EmptyFolder({ icon, title, description, actions }: { icon: ReactNode; title: string; description: string; actions: ReactNode }) {
  return <EmptyState icon={icon} title={title} description={description} actions={actions} />
}
