/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement, ReactNode } from 'react'

// The HUD's reply preview (MV-04): light Markdown only, built as React
// elements (never HTML strings), so a reply can't inject markup into an
// always-on-top window. Paragraphs, lists, headings as strong lines, and
// bold, italic, code and link text inline. Links stay text: the chat has them.

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\s]+\))/g

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const token = match[0]
    const k = `${key}-${i++}`
    if (token.startsWith('`')) out.push(<code key={k}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**') || token.startsWith('__')) out.push(<strong key={k}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('[')) out.push(<span key={k} className="voice-md__link">{token.slice(1, token.indexOf(']'))}</span>)
    else out.push(<em key={k}>{token.slice(1, -1)}</em>)
    last = at + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

type Block = { kind: 'p'; text: string } | { kind: 'h'; text: string } | { kind: 'ul'; items: string[] } | { kind: 'ol'; items: string[] }

/** Splits Markdown into the few blocks the preview shows. Exported for tests. */
export function blocks(markdown: string): Block[] {
  const out: Block[] = []
  const lines = markdown.replace(/```[\s\S]*?```/g, '').split('\n')
  let para: string[] = []
  const flush = (): void => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') })
    para = []
  }
  for (const raw of lines) {
    const line = raw.trim()
    const bullet = /^[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line)
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (!line) flush()
    else if (bullet || numbered) {
      flush()
      const kind = bullet ? 'ul' : 'ol'
      const text = (bullet ?? numbered)?.[1] ?? ''
      const prev = out[out.length - 1]
      if (prev && prev.kind === kind) prev.items.push(text)
      else out.push({ kind, items: [text] })
    } else if (heading) {
      flush()
      out.push({ kind: 'h', text: heading[1] ?? '' })
    } else para.push(line)
  }
  flush()
  return out
}

export function LightMarkdown({ markdown }: { markdown: string }): ReactElement {
  return (
    <div className="voice-md">
      {blocks(markdown).map((b, i) => {
        if (b.kind === 'p') return <p key={i}>{inline(b.text, `p${i}`)}</p>
        if (b.kind === 'h') return <p key={i} className="voice-md__heading">{inline(b.text, `h${i}`)}</p>
        const List = b.kind
        return (
          <List key={i}>
            {b.items.map((item, j) => (
              <li key={j}>{inline(item, `l${i}-${j}`)}</li>
            ))}
          </List>
        )
      })}
    </div>
  )
}
