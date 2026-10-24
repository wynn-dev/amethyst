/** Events pushed from the main process to the renderer. Each domain adds its events here. */
export interface Events {
  'app:ready': { at: number }
}
