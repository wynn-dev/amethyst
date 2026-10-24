import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/ui'
import { queryClient } from '@/data/query'
import { applyAppearance, useSettings } from '@/data/settings'
import { installEventBridge } from '@/data/events'
import { api } from '@/lib/rpc'
import { router } from '@/app/router'
import { installErrorReporting } from './lib/errors'
import './styles.css'

installErrorReporting()
// Runtime and main-process events → cache invalidation and live stores (once per window).
if (window.amethyst) installEventBridge()

/** Applies the colour scheme and accent to this window and to the native chrome. */
function AppearanceSync() {
  const { appearance, accent } = useSettings()
  useEffect(() => applyAppearance({ appearance, accent }), [appearance, accent])
  // Native chrome (title bar, vibrancy, menus) follows the app's scheme too.
  useEffect(() => {
    if (window.amethyst) void api.window.setThemeSource(appearance).catch(() => {})
  }, [appearance])
  return null
}

function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppearanceSync />
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
