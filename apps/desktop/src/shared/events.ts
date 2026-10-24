import type { DeepPatch, GameLogLine, LaunchState, ModpackManualFile, ResourceKind, Settings, TaskView, UpdaterState } from './services'

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

  /** A native menu item was chosen; handled by the focused window. */
  'menu:command': import('./menu').MenuCommandEvent

  /**
   * Version lists changed: `minecraft` and loader lists after a (background) metadata refresh,
   * `installed` after an install or a deletion. Refetch the named lists.
   */
  'versions:changed': { lists: ('minecraft' | 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'installed')[] }

  /** The Java list changed (a scan finished, a runtime was installed, added or removed), or a scan started. */
  'java:changed': { scanning: boolean }

  /** Launch progress and outcome of one run (see `LaunchState`). */
  'launch:state': { instanceId: string; launchId: string } & LaunchState
  /**
   * New game output, only while a log view is subscribed (`launch.subscribeLog`). At most one
   * batch per instance every 100 ms and 500 lines per batch; when lines were skipped, `gap` is
   * true and the view should page them in with `launch.getLog`.
   */
  'launch:log': { instanceId: string; launchId: string; lines: GameLogLine[]; gap: boolean }

  /**
   * Manual (blocked CurseForge) downloads of an instance: a file was matched and placed, or
   * watching stopped. `manual` is what is still missing; `watching` false means the watcher ended.
   */
  'modpack:manual': { instanceId: string; matched: string[]; manual: ModpackManualFile[]; watching: boolean }
}
