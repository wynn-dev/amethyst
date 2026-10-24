import type { ReactElement, ReactNode } from 'react'
import { AlertDialog, Dialog, Popover as RPopover } from 'radix-ui'
import { cn } from './cn'
import { Button } from './Button'

/* ------------------------------------------------------------------------------------------ */
/* Popover                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface PopoverProps {
  trigger: ReactElement
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  width?: number
  /** Accessible name for the popover panel. */
  label: string
  className?: string
  arrow?: boolean
}

/** NSPopover: a translucent panel with an arrow, anchored to its trigger. Esc closes it. */
export function Popover({ trigger, children, open, onOpenChange, side = 'bottom', align = 'center', width, label, className, arrow = true }: PopoverProps) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={10}
          aria-label={label}
          tabIndex={-1}
          // Focus the panel itself rather than its first control; Tab moves into it.
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement | null)?.focus()
          }}
          style={width ? { width } : undefined}
          className={cn(
            'z-50 rounded-xl bg-raised text-label shadow-popover backdrop-blur-2xl outline-none',
            'origin-(--radix-popper-transform-origin) data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in',
            className,
          )}
        >
          {children}
          {arrow && <RPopover.Arrow width={18} height={8} className="fill-raised" />}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Sheet                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface SheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** Optional one-line description under the title. */
  description?: ReactNode
  children: ReactNode
  /** Footer buttons, right-aligned. Put the default (primary) button last. */
  footer?: ReactNode
  /** Leading footer content, e.g. a help button or an inline error. */
  footerLeading?: ReactNode
  width?: number
  /** Hide the visual title (it is still announced). */
  hideTitle?: boolean
  className?: string
  bodyClassName?: string
}

/**
 * A document-modal sheet that slides down from the toolbar, like an AppKit sheet. Focus is
 * trapped while open; Esc and Cancel are always safe because work continues in Activity.
 */
export function Sheet({ open, onOpenChange, title, description, children, footer, footerLeading, width = 520, hideTitle, className, bodyClassName }: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-backdrop data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <Dialog.Content
          style={{ width: `min(${width}px, calc(100vw - 48px))` }}
          className={cn(
            'fixed top-[52px] left-1/2 z-40 flex max-h-[calc(100vh-76px)] -translate-x-1/2 flex-col overflow-hidden rounded-b-xl rounded-t-[4px] bg-sheet text-label shadow-sheet outline-none',
            'data-[state=closed]:animate-sheet-out data-[state=open]:animate-sheet-in',
            className,
          )}
        >
          <div className={cn('px-5 pt-4', hideTitle && 'sr-only')}>
            <Dialog.Title className="text-title3 font-semibold">{title}</Dialog.Title>
            {description ? (
              <Dialog.Description className="mt-0.5 text-body text-label-2">{description}</Dialog.Description>
            ) : (
              <Dialog.Description className="sr-only">{title}</Dialog.Description>
            )}
          </div>
          <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>{children}</div>
          {(footer || footerLeading) && (
            <div className="flex items-center gap-2 border-t border-separator px-5 py-3">
              {footerLeading}
              <div className="ml-auto flex items-center gap-2">{footer}</div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export const SheetClose = Dialog.Close

/* ------------------------------------------------------------------------------------------ */
/* Dialog (centred panel, e.g. the command palette)                                           */
/* ------------------------------------------------------------------------------------------ */

export interface PanelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
  width?: number
  className?: string
  top?: string
}

/** A centred floating panel without chrome, e.g. Spotlight-style palettes. */
export function PanelDialog({ open, onOpenChange, title, children, width = 640, className, top = '18vh' }: PanelDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-transparent" />
        <Dialog.Content
          style={{ width: `min(${width}px, calc(100vw - 48px))`, top }}
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 z-50 -translate-x-1/2 overflow-hidden rounded-2xl bg-raised text-label shadow-sheet backdrop-blur-2xl outline-none',
            'data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in',
            className,
          )}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Alert                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface AlertProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  message?: ReactNode
  /** Label of the confirming button. */
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
  /** Optional extra content (e.g. a checkbox) under the message. */
  children?: ReactNode
  icon?: ReactNode
}

/**
 * NSAlert-style confirmation. Destructive actions use a red button and are never the
 * keyboard default: Return activates Cancel unless the user tabs to the destructive button.
 */
export function Alert({ open, onOpenChange, title, message, confirmLabel, cancelLabel = 'Cancel', destructive, onConfirm, children, icon }: AlertProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-backdrop data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <AlertDialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex w-[272px] -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-xl bg-sheet px-4 pt-5 pb-4 text-center text-label shadow-sheet outline-none',
            'data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in',
          )}
        >
          {icon && <div className="mb-2.5">{icon}</div>}
          <AlertDialog.Title className="text-body font-semibold">{title}</AlertDialog.Title>
          {message ? (
            <AlertDialog.Description className="mt-1.5 text-small text-label">{message}</AlertDialog.Description>
          ) : (
            <AlertDialog.Description className="sr-only">{title}</AlertDialog.Description>
          )}
          {children && <div className="mt-3 w-full text-left">{children}</div>}
          <div className="mt-4 grid w-full grid-cols-2 gap-2">
            <AlertDialog.Cancel asChild>
              <Button size="lg" className="w-full">
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button size="lg" variant={destructive ? 'destructive' : 'primary'} className="w-full" onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
