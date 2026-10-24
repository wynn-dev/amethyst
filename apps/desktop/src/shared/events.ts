import type { DeepPatch, ResourceKind, Settings, TaskView, UpdaterState } from './services'

/**
 * Events pushed to the renderer, from either the runtime or main. Payloads are small: ids and
 * changed keys, never whole collections. Refetch what you display (TanStack Query
 * invalidation) or apply the patch.
 */
export interface Events {
  'runtime:ready': { at: number }
  'runtime:restarted': { at: number; reason: string }

  /** Auto-updater state, pushed from main. */
  'updater:state': UpdaterState

  /**
   * Settings changed. `keys` are the dotted paths of the leaves that changed (e.g.
   * `appearance.theme`); `patch` holds exactly those leaves with their new values.
   */
  'settings:changed': { keys: string[]; patch: DeepPatch<Settings> }

  /** Instances were added, edited (including renames and play-time updates) or removed. */
  'instances:changed': { added: string[]; updated: string[]; removed: string[] }

  /**
   * A content folder changed. `changed` rows were added or updated (refetch them), `removed`
   * rows are gone. `reset` means the whole list should be refetched (e.g. a scan finished on a
   * cold index). Coalesced: at most a few per second per folder.
   */
  'resources:changed': { instanceId: string; kind: ResourceKind; revision: number; changed: string[]; removed: string[]; reset: boolean }
  /** A scan of a content folder started or finished. */
  'resources:scan': { instanceId: string; kind: ResourceKind; scanning: boolean }

  /** The account list or an account's public fields changed. */
  'accounts:changed': { ids: string[]; removed: string[]; selectedId: string | null }
  /** Interactive Microsoft sign-in progress. */
  'accounts:login':
    | { stage: 'window' }
    | { stage: 'browser'; url: string }
    | { stage: 'device-code'; userCode: string; verificationUri: string; expiresAt: number }
    | { stage: 'signing-in' }
    | { stage: 'done'; accountId: string }
    | { stage: 'failed'; code: string; message: string }

  /**
   * Task snapshots, throttled to at most 10 batches per second. `tasks` holds only the tasks that
   * changed since the previous batch; `removed` lists dismissed or evicted task ids.
   */
  'tasks:update': { tasks: TaskView[]; removed: string[] }
}
