/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Renders a guide's Markdown subset (shared/guideMarkdown.ts) as React
// elements, never as HTML; only apex:// links become links.
import type { ReactElement, ReactNode } from 'react'
import { Lightbulb } from 'lucide-react'
import { parseGuide, type GuideBlock, type GuideInline } from '@shared/guideMarkdown'
import { call, errorText } from '../api'
import { toast } from '../ui'

const openPage = (href: string): void => {
  call('pages', 'open', href).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
}

function Inline({ nodes }: { nodes: readonly GuideInline[] }): ReactElement {
  return (
    <>
      {nodes.map((node, i): ReactNode => {
        switch (node.type) {
          case 'text':
            return node.text
          case 'strong':
            return <strong key={i}><Inline nodes={node.children} /></strong>
          case 'em':
            return <em key={i}><Inline nodes={node.children} /></em>
          case 'code':
            return <code key={i}>{node.text}</code>
          case 'link':
            return (
              <a key={i} href={node.href} onClick={(e) => { e.preventDefault(); openPage(node.href) }}>
                <Inline nodes={node.children} />
              </a>
            )
        }
      })}
    </>
  )
}

function Block({ block }: { block: GuideBlock }): ReactElement {
  switch (block.type) {
    case 'heading': {
      const Tag = block.level === 1 ? 'h1' : block.level === 2 ? 'h2' : 'h3'
      return <Tag><Inline nodes={block.children} /></Tag>
    }
    case 'paragraph':
      return <p><Inline nodes={block.children} /></p>
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return <Tag>{block.items.map((item, i) => <li key={i}><Inline nodes={item} /></li>)}</Tag>
    }
    case 'tip':
      return (
        <div className="gd-text__tip" role="note">
          <Lightbulb size={16} aria-hidden />
          <p><Inline nodes={block.children} /></p>
        </div>
      )
  }
}

export function GuideText({ source }: { source: string }): ReactElement {
  return <div className="gd-text">{parseGuide(source).map((block, i) => <Block key={i} block={block} />)}</div>
}
