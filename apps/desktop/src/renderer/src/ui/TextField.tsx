import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { Search, XCircle } from 'lucide-react'
import { cn } from './cn'

/** A flat field: a faint fill with an inner hairline that firms up on focus. */
export const fieldClass =
  'w-full rounded-md bg-field text-compact text-label placeholder:text-label-3 ' +
  'shadow-[inset_0_0_0_0.5px_var(--color-separator-2)] ' +
  'outline-none transition-shadow duration-150 focus:shadow-[inset_0_0_0_1px_var(--focus-ring),0_0_0_3px_color-mix(in_srgb,var(--accent)_10%,transparent)] ' +
  'disabled:opacity-50 aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--color-red)]'

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Visible label above the field. Omit it only when `aria-label` is given. */
  label?: string
  /** Inline validation message, shown under the field. Never disable a button without one. */
  error?: string
  /** Secondary help text under the field. */
  hint?: ReactNode
  size?: 'md' | 'lg'
  monospace?: boolean
}

/** A text field with an optional label, hint and inline error. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, hint, size = 'md', monospace, className, id, ...rest },
  ref,
) {
  const autoId = useId()
  const inputId = id ?? autoId
  const msgId = `${inputId}-msg`
  const input = (
    <input
      ref={ref}
      id={inputId}
      aria-invalid={error ? true : undefined}
      aria-describedby={error || hint ? msgId : undefined}
      spellCheck={false}
      className={cn(fieldClass, size === 'md' ? 'h-[26px] px-2' : 'h-[30px] rounded-lg px-2.5 text-body', monospace && 'font-mono text-meta', !label && className)}
      {...rest}
    />
  )
  if (!label && !error && !hint) return input
  return (
    <div className={cn('flex flex-col gap-1', label ? className : undefined)}>
      {label && (
        <label htmlFor={inputId} className="text-compact text-label">
          {label}
        </label>
      )}
      {input}
      {(error || hint) && (
        <p id={msgId} className={cn('text-meta', error ? 'text-red' : 'text-label-2')}>
          {error ?? hint}
        </p>
      )}
    </div>
  )
})

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { monospace?: boolean }>(
  function TextArea({ className, monospace, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        spellCheck={false}
        className={cn(fieldClass, 'min-h-16 resize-y px-2 py-1.5', monospace && 'font-mono text-meta', className)}
        {...rest}
      />
    )
  },
)

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'size'> {
  value: string
  onValueChange: (value: string) => void
  /** Accessible name. Defaults to the placeholder. */
  label?: string
  size?: 'md' | 'lg'
}

/** Search field with a magnifier and a clear button. Esc clears, then blurs. */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onValueChange, label, placeholder = 'Search', size = 'md', className, onKeyDown, ...rest },
  ref,
) {
  return (
    <div className={cn('relative flex items-center', className)}>
      <Search aria-hidden className={cn('pointer-events-none absolute left-2 text-label-3', size === 'md' ? 'size-[13px]' : 'left-2.5 size-3.5')} />
      <input
        ref={ref}
        type="search"
        role="searchbox"
        aria-label={label ?? placeholder}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (value) {
              e.stopPropagation()
              onValueChange('')
            } else e.currentTarget.blur()
          }
          onKeyDown?.(e)
        }}
        className={cn(
          'w-full rounded-md bg-fill pr-6 text-label outline-none placeholder:text-label-3',
          'shadow-[inset_0_0_0_0.5px_var(--color-separator)] transition-shadow duration-150 focus:shadow-[inset_0_0_0_1px_var(--focus-ring)]',
          '[&::-webkit-search-cancel-button]:hidden',
          size === 'md' ? 'h-[26px] pl-[26px] text-callout' : 'h-[30px] rounded-lg pl-8 text-body',
        )}
        {...rest}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onValueChange('')}
          className="absolute right-1.5 flex size-4 items-center justify-center text-label-3 hover:text-label-2"
        >
          <XCircle aria-hidden className="size-3.5 fill-current stroke-window" />
        </button>
      )}
    </div>
  )
})
