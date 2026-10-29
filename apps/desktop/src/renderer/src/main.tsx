import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { LucideProvider } from 'lucide-react'
import { TooltipProvider } from '@/ui'
import { queryClient } from '@/data/query'
import { useAppearanceSync } from '@/data/appearance'
import { installEventBridge } from '@/data/events'
import { applyTheme, readCachedTheme } from '@/lib/theme'
import { router } from '@/app/router'
import { installErrorReporting } from './lib/errors'
import { markOnce } from './lib/perf'
import './styles.css'

markOnce('entry')

installErrorReporting()
// Runtime and main-process events → cache invalidation and live stores (once per window).
if (window.amethyst) installEventBridge()

// Paint the first frame with the last known theme; settings replace it once they arrive.
const cachedTheme = readCachedTheme()
if (cachedTheme) applyTheme(cachedTheme)

/** Applies the colour scheme and accent to this window and to the native chrome. */
function AppearanceSync() {
  useAppearanceSync()
  return null
}

function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppearanceSync />
      {/* One quiet icon stroke everywhere; an explicit `strokeWidth` still wins. */}
      <LucideProvider strokeWidth={1.5}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </LucideProvider>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
