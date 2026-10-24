import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/ui'
import { queryClient } from '@/data/query'
import { useAppearanceSync } from '@/data/appearance'
import { applyTheme, readCachedTheme } from '@/lib/theme'
import { router } from '@/app/router'
import { installErrorReporting } from './lib/errors'
import './styles.css'

installErrorReporting()

// Paint the first frame with the last known theme; settings replace it once they arrive.
const cachedTheme = readCachedTheme()
if (cachedTheme) applyTheme(cachedTheme)

/** Applies the theme from settings to this window, and follows changes. */
function AppearanceSync() {
  useAppearanceSync()
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
