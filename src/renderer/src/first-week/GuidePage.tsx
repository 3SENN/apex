/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, type ReactElement, type ReactNode } from 'react'
import { ArrowLeft, Lightbulb } from 'lucide-react'
import { FIRST_WEEK_GUIDES, guideById, guideUrl } from '@shared/firstWeek'
import { parseGuide, type GuideBlock, type GuideInline } from '@shared/guideMarkdown'
import { atelier, call, errorText } from '../api'
import { toast } from '../ui'
import { GuideScene } from './scenes'
import { GuideCard } from './Tutorials'
import { useLanguage, useT } from '../i18n/useT'
import { withBrand } from '@shared/branding'
import { currentLanguage } from '@shared/i18n/core'

// The guides ship with the chrome as Markdown, bundled at build time.
const SOURCES = import.meta.glob<string>('./guides/*.md', { query: '?raw', import: 'default', eager: true })
/** The Dutch guides, read when Atelier speaks Dutch; English stands in for one that is missing. */
const SOURCES_NL = import.meta.glob<string>('./guides/nl/*.md', { query: '?raw', import: 'default', eager: true })

/** A guide's Markdown in the app language, with {brand} filled in (src/shared/branding.ts). */
export function guideSource(id: string, language: string = currentLanguage()): string | null {
  if (language === 'nl') {
    const dutch = SOURCES_NL[`./guides/nl/${id}.md`]
    if (dutch) return withBrand(dutch)
  }
  const english = SOURCES[`./guides/${id}.md`]
  return english === undefined ? null : withBrand(english)
}

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
              <a
                key={i}
                href={node.href}
                onClick={(e) => {
                  e.preventDefault()
                  openPage(node.href)
                }}
              >
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
        <div className="fw-doc__tip" role="note">
          <Lightbulb size={16} aria-hidden />
          <p><Inline nodes={block.children} /></p>
        </div>
      )
  }
}

/** One guide: its scene playing at the top, the text, and the next guide. */
export function GuidePage({ id, tabId }: { id: string; tabId: string }): ReactElement {
  const t = useT()
  const guide = guideById(id)
  const { language } = useLanguage()
  const blocks = useMemo(() => parseGuide(guideSource(id, language) ?? ''), [id, language])
  const index = FIRST_WEEK_GUIDES.findIndex((g) => g.id === id)
  const next = FIRST_WEEK_GUIDES[(index + 1) % FIRST_WEEK_GUIDES.length]
  return (
    <article className="fw-guide">
      <button type="button" className="fw-guide__back" onClick={() => openPage('atelier://first-week')}>
        <ArrowLeft size={15} aria-hidden />
        {t('firstRun.weekGuidePage.gettingStarted')}
      </button>
      <div className="fw-guide__stage">
        <GuideScene id={id} playing />
      </div>
      {guide && <p className="fw-guide__meta">{t('firstRun.weekGuidePage.minRead', { minutes: guide.minutes })}</p>}
      <div className="fw-doc">
        {blocks.map((block, i) => <Block key={i} block={block} />)}
      </div>
      {next && next.id !== id && (
        <footer className="fw-guide__next">
          <p className="fw-guide__next-label">{t('firstRun.weekGuidePage.upNext')}</p>
          <GuideCard guide={next} onOpen={() => void atelier.nav.go(tabId, guideUrl(next.id))} />
        </footer>
      )}
    </article>
  )
}
