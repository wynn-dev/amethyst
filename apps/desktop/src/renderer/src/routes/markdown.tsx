import { memo, useMemo, type MouseEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { openExternal } from '@/lib/files'
import { cn } from '@/ui'

/**
 * Untrusted project descriptions and changelogs (Modrinth Markdown, CurseForge HTML), rendered
 * to sanitised HTML. Lazily loaded: marked and DOMPurify stay out of the entry bundle.
 *
 * - Scripts, styles, forms, frames and event handlers are removed (DOMPurify).
 * - Only `https:` links and images survive; links open in the system browser.
 */

const FORBID_TAGS = ['style', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'object', 'embed', 'video', 'audio', 'source', 'link', 'meta', 'base']

let hooked = false
function installHooks(): void {
  if (hooked) return
  hooked = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? ''
      if (/^https:\/\//i.test(href)) {
        node.setAttribute('rel', 'noreferrer noopener')
        node.setAttribute('title', href)
      } else if (!href.startsWith('#')) node.removeAttribute('href')
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? ''
      if (!/^https:\/\//i.test(src)) node.remove()
      else {
        node.setAttribute('loading', 'lazy')
        node.setAttribute('decoding', 'async')
        node.setAttribute('referrerpolicy', 'no-referrer')
      }
    }
  })
}

export function renderSafeHtml(source: string, format: 'markdown' | 'html'): string {
  installHooks()
  const html = format === 'markdown' ? (marked.parse(source, { async: false, gfm: true, breaks: false }) as string) : source
  return DOMPurify.sanitize(html, { FORBID_TAGS, FORBID_ATTR: ['style', 'class', 'id'], ALLOW_DATA_ATTR: false })
}

function onClick(e: MouseEvent<HTMLDivElement>) {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  const href = a.getAttribute('href') ?? ''
  if (href.startsWith('#')) return
  e.preventDefault()
  if (href) openExternal(href)
}

export const Markdown = memo(function Markdown({ source, format = 'markdown', className }: { source: string; format?: 'markdown' | 'html'; className?: string }) {
  const html = useMemo(() => renderSafeHtml(source, format), [source, format])
  if (!html.trim()) return <p className="text-body text-label-3">No description.</p>
  // oxlint-disable-next-line react/no-danger -- sanitised above
  return <div className={cn('md-body selectable', className)} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
})

export default Markdown
