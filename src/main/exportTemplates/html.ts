/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Export templates (CH-36): a standalone HTML document for a
// chat, skill, transcript or generated document. Markdown goes through the
// same parser the chat uses, and every piece of text is escaped, so nothing
// from a reply ever becomes markup. The document carries its own light and
// dark palette (it is opened outside Atelier), with no scripts and no remote loads.
import { parseMarkdown, safeHref, type Block, type Inline } from '../../renderer/src/chat/logic/markdown'

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

function inline(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
          return escapeHtml(node.text)
        case 'code':
          return `<code>${escapeHtml(node.text)}</code>`
        case 'strong':
          return `<strong>${inline(node.children)}</strong>`
        case 'em':
          return `<em>${inline(node.children)}</em>`
        case 'del':
          return `<del>${inline(node.children)}</del>`
        case 'br':
          return '<br>'
        case 'link': {
          const href = safeHref(node.href)
          return href ? `<a href="${escapeHtml(href)}">${inline(node.children)}</a>` : inline(node.children)
        }
      }
    })
    .join('')
}

function blocks(nodes: readonly Block[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'paragraph':
          return `<p>${inline(node.children)}</p>`
        case 'heading':
          // Headings inside a message sit below the message heading.
          return `<h${Math.min(6, node.level + 2)}>${inline(node.children)}</h${Math.min(6, node.level + 2)}>`
        case 'code':
          return `<pre><code>${escapeHtml(node.text)}</code></pre>`
        case 'quote':
          return `<blockquote>${blocks(node.children)}</blockquote>`
        case 'rule':
          return '<hr>'
        case 'list': {
          const tag = node.ordered ? 'ol' : 'ul'
          const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : ''
          const items = node.items
            .map((item) => `<li>${item.checked === null ? '' : `<input type="checkbox" disabled${item.checked ? ' checked' : ''}> `}${blocks(item.children)}</li>`)
            .join('')
          return `<${tag}${start}>${items}</${tag}>`
        }
        case 'table': {
          const align = (i: number): string => (node.align[i] ? ` style="text-align:${node.align[i]}"` : '')
          const head = node.head.map((cell, i) => `<th${align(i)}>${inline(cell)}</th>`).join('')
          const rows = node.rows.map((row) => `<tr>${row.map((cell, i) => `<td${align(i)}>${inline(cell)}</td>`).join('')}</tr>`).join('')
          return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`
        }
      }
    })
    .join('\n')
}

/** Markdown as escaped HTML. */
export function markdownToHtml(markdown: string): string {
  return blocks(parseMarkdown(markdown))
}

// The exported page's own palette: a document opened in any browser, so it
// defines its colours once per scheme instead of borrowing Atelier's tokens.
const STYLE = `
:root { color-scheme: light dark; --ink: #1d1c1a; --muted: #6b6862; --line: #e4e1dc; --paper: #ffffff; --wash: #f6f4f1; --link: #2f5fb3; }
@media (prefers-color-scheme: dark) { :root { --ink: #ecebe8; --muted: #a29f99; --line: #3a3835; --paper: #1f1e1c; --wash: #2a2927; --link: #8fb3f0; } }
@media print { :root { --ink: #000; --muted: #444; --line: #ccc; --paper: #fff; --wash: #f3f3f3; --link: #000; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
main { max-width: 680px; margin: 0 auto; padding: 40px 24px 64px; }
header { margin-bottom: 32px; }
h1 { font-size: 24px; line-height: 1.3; margin: 0 0 6px; }
.meta { color: var(--muted); font-size: 13px; margin: 0; }
section { margin: 0 0 24px; }
section > h2 { font-size: 13px; text-transform: none; color: var(--muted); font-weight: 600; margin: 0 0 6px; }
section > h2 time { font-weight: 400; margin-left: 6px; }
section.you .body { background: var(--wash); border-radius: 12px; padding: 10px 14px; }
.body > :first-child { margin-top: 0; } .body > :last-child { margin-bottom: 0; }
a { color: var(--link); }
code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--wash); border-radius: 4px; padding: 1px 4px; }
pre { background: var(--wash); border-radius: 8px; padding: 12px; overflow-x: auto; white-space: pre-wrap; }
pre code { background: none; padding: 0; }
blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--line); color: var(--muted); }
table { border-collapse: collapse; } th, td { border: 1px solid var(--line); padding: 4px 8px; }
hr { border: 0; border-top: 1px solid var(--line); }
`

export interface HtmlSection {
  heading: string
  at?: number | null
  markdown: string
  /** 'you' tints the section like your bubble in the chat. */
  tone?: 'you' | 'companion' | 'plain'
}

/** A complete, script-free HTML document. */
export function htmlDocument(input: { title: string; meta?: string; sections: readonly HtmlSection[]; lang?: string }): string {
  const sections = input.sections
    .map((s) => {
      const time = s.at ? `<time datetime="${new Date(s.at).toISOString()}">${escapeHtml(new Date(s.at).toLocaleString())}</time>` : ''
      return `<section class="${s.tone ?? 'plain'}"><h2>${escapeHtml(s.heading)}${time}</h2><div class="body">${markdownToHtml(s.markdown)}</div></section>`
    })
    .join('\n')
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(input.lang ?? 'en')}">`,
    '<head>',
    '<meta charset="utf-8">',
    // Nothing in an export runs or loads from elsewhere.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body><main>',
    `<header><h1>${escapeHtml(input.title)}</h1>${input.meta ? `<p class="meta">${escapeHtml(input.meta)}</p>` : ''}</header>`,
    sections,
    '</main></body>',
    '</html>',
    '',
  ].join('\n')
}

/** A single Markdown body (a skill, a transcript or a document) as a document. */
export function markdownDocument(title: string, markdown: string, meta?: string): string {
  return htmlDocument({ title, ...(meta ? { meta } : {}), sections: [{ heading: '', markdown, tone: 'plain' }] }).replace('<h2></h2>', '')
}
