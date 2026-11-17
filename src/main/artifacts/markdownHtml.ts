/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseMarkdown, safeHref, type Block, type Inline } from '../../renderer/src/chat/logic/markdown'

// A Markdown artifact as a standalone HTML page ("Open as artifact"
// for .md). It reuses the chat's Markdown parser, escapes every piece of
// text, and styles itself with the system's own colours so it follows light
// and dark without any hard-coded colour.

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function inline(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case 'text':
          return esc(n.text)
        case 'code':
          return `<code>${esc(n.text)}</code>`
        case 'strong':
          return `<strong>${inline(n.children)}</strong>`
        case 'em':
          return `<em>${inline(n.children)}</em>`
        case 'del':
          return `<del>${inline(n.children)}</del>`
        case 'br':
          return '<br>'
        case 'link': {
          const href = safeHref(n.href)
          // Artifact tabs can't navigate; the address stays readable in the title.
          return href ? `<a href="${esc(href)}" title="${esc(href)}">${inline(n.children)}</a>` : inline(n.children)
        }
      }
    })
    .join('')
}

function blocks(list: readonly Block[]): string {
  return list.map(block).join('\n')
}

function block(b: Block): string {
  switch (b.kind) {
    case 'paragraph':
      return `<p>${inline(b.children)}</p>`
    case 'heading':
      return `<h${b.level}>${inline(b.children)}</h${b.level}>`
    case 'code':
      return `<pre><code>${esc(b.text)}</code></pre>`
    case 'quote':
      return `<blockquote>${blocks(b.children)}</blockquote>`
    case 'rule':
      return '<hr>'
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul'
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : ''
      const items = b.items.map((item) => `<li>${item.checked === null ? '' : `<input type="checkbox" disabled${item.checked ? ' checked' : ''}> `}${blocks(item.children)}</li>`).join('')
      return `<${tag}${start}>${items}</${tag}>`
    }
    case 'table': {
      const align = (i: number): string => (b.align[i] ? ` style="text-align:${b.align[i]}"` : '')
      const head = `<tr>${b.head.map((cell, i) => `<th${align(i)}>${inline(cell)}</th>`).join('')}</tr>`
      const rows = b.rows.map((row) => `<tr>${row.map((cell, i) => `<td${align(i)}>${inline(cell)}</td>`).join('')}</tr>`).join('')
      return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`
    }
  }
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; background: Canvas; color: CanvasText; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
main { max-width: 672px; margin: 0 auto; padding: 48px 24px 96px; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.6em; }
h1 { font-size: 1.75em; } h2 { font-size: 1.4em; } h3 { font-size: 1.15em; }
a { color: LinkText; }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; padding: 0.1em 0.3em; border-radius: 4px; outline: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }
pre { padding: 12px 14px; border-radius: 10px; overflow: auto; background: color-mix(in srgb, CanvasText 5%, Canvas); }
pre code { outline: none; padding: 0; }
blockquote { margin: 0; padding-left: 14px; border-left: 3px solid color-mix(in srgb, CanvasText 18%, transparent); color: color-mix(in srgb, CanvasText 72%, Canvas); }
table { border-collapse: collapse; margin: 1em 0; }
th, td { padding: 6px 10px; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }
hr { border: 0; border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent); margin: 2em 0; }
`

export function markdownDocument(markdown: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${blocks(parseMarkdown(markdown))}</main></body></html>`
}
