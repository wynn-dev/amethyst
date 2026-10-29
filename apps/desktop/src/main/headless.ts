/**
 * Keeps dev-only automated runs (screenshots, the UI end-to-end drivers) off the user's screen.
 *
 * Every window still renders and `capturePage` still sees it, but it is fully transparent,
 * ignores the mouse, never takes focus, and the app has no Dock icon, so a run can happen while
 * someone works on the same Mac. `AMETHYST_VISIBLE=1` opts back in to watching a run.
 */
import { app, type BrowserWindow } from 'electron'

export function keepOffScreen(): void {
  app.dock?.hide()
  app.on('browser-window-created', (_event, win) => hide(win))
}

function hide(win: BrowserWindow) {
  win.setOpacity(0)
  win.setIgnoreMouseEvents(true)
  win.setFocusable(false)
  // Hidden windows count as occluded; keep them painting at full rate for the capture.
  win.webContents.setBackgroundThrottling(false)
  win.show = () => win.showInactive()
  win.focus = () => {}
}
