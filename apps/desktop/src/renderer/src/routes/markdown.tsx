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

/**
 * Calm long-form typography (callers cap the measure at ~680px): 13px on a 1.6 line, paragraphs
 * spaced by rhythm rather than rules, small semibold headings, hairline code blocks, quotes and
 * tables, softly rounded images. Links are the label colour with a faint underline. Scoped to
 * this component (it replaces the old global `.md-body` rules).
 */
const prose = [
  'selectable min-w-0 text-body leading-[1.6] text-label break-words',
  '[&>*+*]:mt-[0.8em] [&_:is(p,ul,ol,blockquote,pre,table)+*]:mt-[0.8em]',
  '[&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:leading-snug [&_:is(h1,h2,h3,h4,h5,h6)]:text-label [&_:is(h1,h2,h3,h4,h5,h6)]:tracking-tight',
  '[&_:is(h1,h2,h3,h4,h5,h6)]:mt-[1.5em] [&>:is(h1,h2,h3,h4,h5,h6):first-child]:mt-0',
  '[&_h1]:text-title3 [&_h2]:text-headline [&_:is(h3,h4,h5,h6)]:text-body',
  '[&_strong]:font-semibold [&_em]:italic',
  '[&_a]:text-label [&_a]:underline [&_a]:decoration-label-3 [&_a]:underline-offset-2 [&_a:hover]:decoration-label-2',
  '[&_:is(ul,ol)]:pl-[1.3em] [&_ul]:list-disc [&_ol]:list-decimal [&_li+li]:mt-[0.3em] [&_li]:marker:text-label-3',
  '[&_img]:inline-block [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-md [&_img]:align-middle',
  '[&_:is(code,pre)]:font-mono [&_:is(code,pre)]:text-[11.5px]',
  '[&_code]:rounded-[4px] [&_code]:bg-fill [&_code]:px-[0.35em] [&_code]:py-[0.1em]',
  '[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-separator [&_pre]:px-3 [&_pre]:py-2.5 [&_pre]:leading-relaxed [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-separator-2 [&_blockquote]:pl-3 [&_blockquote]:text-label-2',
  '[&_hr]:my-[1.5em] [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-separator',
  '[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-compact',
  '[&_:is(td,th)]:border [&_:is(td,th)]:border-separator [&_:is(td,th)]:px-2 [&_:is(td,th)]:py-1 [&_th]:text-left [&_th]:font-semibold',
  '[&_details]:rounded-lg [&_details]:border [&_details]:border-separator [&_details]:px-3 [&_details]:py-2 [&_summary]:cursor-default [&_summary]:font-medium',
].join(' ')

export const Markdown = memo(function Markdown({ source, format = 'markdown', className }: { source: string; format?: 'markdown' | 'html'; className?: string }) {
  const html = useMemo(() => renderSafeHtml(source, format), [source, format])
  if (!html.trim()) return <p className="text-body text-label-3">No description.</p>
  // oxlint-disable-next-line react/no-danger -- sanitised above
  return <div className={cn(prose, className)} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
})

export default Markdown
