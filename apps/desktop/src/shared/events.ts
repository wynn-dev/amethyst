/** Events pushed to the renderer, from either the runtime or main. Each domain adds its events here. */
export interface Events {
  'runtime:ready': { at: number }
  'runtime:restarted': { at: number; reason: string }
}
