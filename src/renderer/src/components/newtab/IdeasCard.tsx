/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { ArrowRight, BookOpen, ChefHat, ChevronLeft, ChevronRight, Globe, Lightbulb, Mail, Newspaper, Plane, Repeat, Scale, Sparkles, SquareStack, WandSparkles, X } from 'lucide-react'
import type { Routine } from '@shared/routines'
import type { Skill } from '@shared/skills'
import type { TabInfo } from '@shared/ipc'
import { atelier, call, useLiveList } from '../../api'
import { motionReduced } from '../../ui/motion'
import { buildIdeaPages, clampPage, pagerState, type Idea, type IdeaGlyph } from './newtabLogic'
import { useT } from '../../i18n/useT'

// The ideas card (DS-109): a header row with a bulb and previous and next
// arrows, then a two-column card: the page's title, description and see-all
// link on the left, four idea rows on the right. Hovering a row shows a
// dismiss × and, after about 0.9 s, the full prompt. A click prefills the
// composer, or sends for one-shot ideas. Pages slide on the paged-strip
// motion (DS-142); Reduce Motion swaps them at once.

const PREVIEW_MS = 900
const DISMISSED_KEY = 'atelier.newtab.ideas.dismissed'

const GLYPHS: Record<IdeaGlyph, typeof Sparkles> = {
  sparkles: Sparkles,
  globe: Globe,
  news: Newspaper,
  mail: Mail,
  plane: Plane,
  scale: Scale,
  chef: ChefHat,
  tabs: SquareStack,
  wand: WandSparkles,
  repeat: Repeat,
  book: BookOpen,
}

function readDismissed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeDismissed(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-200)))
  } catch {
    // A blocked store only means dismissals last until the page reloads.
  }
}

function useTabs(): readonly TabInfo[] {
  const [tabs, setTabs] = useState<readonly TabInfo[]>(() => atelier.initial.tabs.tabs)
  useEffect(() => atelier.tabs.onChanged((snapshot) => setTabs(snapshot.tabs)), [])
  return tabs
}

interface IdeasCardProps {
  companionName: string
  /** Puts the prompt in the composer for you to finish. */
  onPrefill(prompt: string): void
  /** Sends a one-shot idea at once. */
  onSend(prompt: string): void
  compact?: boolean
}

export function IdeasCard({ companionName, onPrefill, onSend, compact = false }: IdeasCardProps): ReactElement | null {
  const t = useT()
  const [skills] = useLiveList<Skill, 'skills'>(() => call('skills', 'list').catch(() => []), 'skills', (e) => e.items)
  const [routines] = useLiveList<Routine, 'routines'>(() => (call('routines', 'list') as Promise<Routine[]>).catch(() => []), 'routines', (e) => e.items)
  const tabs = useTabs()
  const [dismissed, setDismissed] = useState(readDismissed)
  const pages = useMemo(
    () =>
      buildIdeaPages({
        companionName,
        skills: skills.filter((s) => s.source === 'user'),
        routines: routines.map((r) => ({ id: r.id, name: r.name, prompt: r.prompt, enabled: r.enabled })),
        tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })),
        dismissed,
      }),
    [companionName, skills, routines, tabs, dismissed],
  )
  const [index, setIndex] = useState(0)
  const at = clampPage(index, pages.length)
  const { canPrev, canNext } = pagerState(at, pages.length)
  const [preview, setPreview] = useState<Idea | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  if (pages.length === 0) return null

  const hover = (idea: Idea | null): void => {
    window.clearTimeout(timer.current)
    if (!idea) return setPreview(null)
    timer.current = window.setTimeout(() => setPreview(idea), PREVIEW_MS)
  }
  const pick = (idea: Idea): void => {
    hover(null)
    if (idea.oneShot) onSend(idea.prompt)
    else onPrefill(idea.prompt)
  }
  const dismiss = (idea: Idea): void => {
    hover(null)
    const next = new Set(dismissed)
    next.add(idea.id)
    writeDismissed(next)
    setDismissed(next)
  }
  const page = (delta: number): void => {
    hover(null)
    setIndex(clampPage(at + delta, pages.length))
  }

  return (
    <section className={['nt-ideas', compact && 'nt-ideas--compact'].filter(Boolean).join(' ')} aria-label={t('tabs.newTabIdeasCard.ideas')} data-reduced={motionReduced() ? 'true' : undefined}>
      <header className="nt-ideas__head">
        <Lightbulb aria-hidden />
        <span className="nt-ideas__label">{t('tabs.newTabIdeasCard.ideasFor', { companionName })}</span>
        <span className="nt-ideas__pager">
          <button type="button" className="nt-ideas__arrow" aria-label={t('tabs.newTabIdeasCard.previousIdeas')} disabled={!canPrev} onClick={() => page(-1)}>
            <ChevronLeft aria-hidden />
          </button>
          <button type="button" className="nt-ideas__arrow" aria-label={t('tabs.newTabIdeasCard.nextIdeas')} disabled={!canNext} onClick={() => page(1)}>
            <ChevronRight aria-hidden />
          </button>
        </span>
      </header>
      <div className="nt-ideas__viewport">
        <div className="nt-ideas__strip" style={{ '--page': at } as CSSProperties}>
          {pages.map((p, i) => (
            <div key={p.id} className="nt-ideas__card" data-current={i === at ? 'true' : undefined} aria-hidden={i === at ? undefined : true} inert={i === at ? undefined : true}>
              <div className="nt-ideas__about">
                <h3 className="nt-ideas__title">{p.title}</h3>
                <p className="nt-ideas__description">{p.description}</p>
                {p.seeAll && (
                  <button type="button" className="nt-ideas__see-all" onClick={() => void call('pages', 'open', p.seeAll!.url)}>
                    {p.seeAll.label} <ArrowRight aria-hidden />
                  </button>
                )}
              </div>
              <ul className="nt-ideas__rows">
                {p.ideas.map((idea) => {
                  const Glyph = GLYPHS[idea.glyph]
                  return (
                    <li key={idea.id} className="nt-ideas__row" onPointerEnter={() => hover(idea)} onPointerLeave={() => hover(null)}>
                      <button
                        type="button"
                        className="nt-ideas__pick"
                        title={idea.prompt}
                        onFocus={() => hover(idea)}
                        onBlur={() => hover(null)}
                        onClick={() => pick(idea)}
                      >
                        <Glyph aria-hidden />
                        <span>{idea.label}</span>
                        <span className="ui-sr-only">{idea.oneShot ? t('tabs.newTabIdeasCard.sendsNow') : t('tabs.newTabIdeasCard.fillsInTheComposer')}</span>
                      </button>
                      <button type="button" className="nt-ideas__dismiss" aria-label={t('tabs.newTabIdeasCard.hide', { label: idea.label })} onClick={() => dismiss(idea)}>
                        <X aria-hidden />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
        {preview && (
          <div className="nt-ideas__preview" role="tooltip">
            {preview.prompt}
          </div>
        )}
      </div>
    </section>
  )
}
