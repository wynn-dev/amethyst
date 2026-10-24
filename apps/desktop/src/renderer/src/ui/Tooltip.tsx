import type { ReactElement, ReactNode } from 'react'
import { Tooltip as R } from 'radix-ui'
import { shortcutGlyphs } from './cn'

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <R.Provider delayDuration={600} skipDelayDuration={300}>
    {children}
  </R.Provider>
)

export interface TooltipProps {
  content: ReactNode
  shortcut?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactElement
}

/** macOS help tag. Appears after a short delay; includes the shortcut when one is given. */
export function Tooltip({ content, shortcut, side = 'bottom', children }: TooltipProps) {
  return (
    <R.Root>
      <R.Trigger asChild>{children}</R.Trigger>
      <R.Portal>
        <R.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[60] flex items-center gap-2 rounded-[5px] bg-raised px-2 py-[3px] text-small text-label shadow-popover backdrop-blur-xl data-[state=closed]:animate-fade-out data-[state=delayed-open]:animate-fade-in"
        >
          {content}
          {shortcut && <span className="text-label-2 tracking-[0.06em]">{shortcutGlyphs(shortcut)}</span>}
        </R.Content>
      </R.Portal>
    </R.Root>
  )
}
