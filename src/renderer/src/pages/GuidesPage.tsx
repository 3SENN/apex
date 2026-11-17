/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Guides destination (ON-16; atelier://guides[/<id>]): Atelier's own
// guides and curated bundles, with category filters and search. A guide's
// page shows its text and its bundle; Try it installs the bundle (built-in
// skills ready, routines saved paused for review, connectors suggested) or
// starts a chat about the guide.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { ArrowLeft, BookOpenText, CalendarClock, ChevronLeft, ChevronRight, Clock, Compass, House, ListChecks, PenLine, Plane, Plug, ShoppingBag, Sparkles, Users, WandSparkles } from 'lucide-react'
import { GUIDE_CATEGORIES, filterGuides, guideUrl, type Guide, type GuideCategory, type GuideTryResult } from '@shared/guides'
import type { MessageKey } from '@shared/i18n/en'
import { connectorConnectUrl } from '@shared/connectors'
import { chatUrl, routineUrl } from '@shared/url'
import { t } from '@shared/i18n/core'
import { atelier, call, errorText } from '../api'
import { GuideText } from '../guidance/GuideText'
import { DestinationFrame } from '../settings/destinations/common'
import { DestinationToolbar, PageError, PageHeader, PageSkeleton } from '../settings/kit'
import { Badge, Button, EmptyState, cx, toast } from '../ui'
import { useT } from '../i18n/useT'
import { carouselLayout, categoryCounts, offsetFor, stepCarousel } from '../ui/logic/carousel'
import '../guidance/guidance.css'
import '../guidance/guides.css'

export interface GuidesPageProps {
  tabId: string
  guideId: string | null
}

type Category = 'all' | (typeof GUIDE_CATEGORIES)[number]['id']
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(GUIDE_CATEGORIES.map((c) => [c.id, c.label]))

function useGuides(): { guides: Guide[] | null; error: string | null; reload(): void } {
  const [guides, setGuides] = useState<Guide[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = (): void => {
    setError(null)
    call('guides', 'list').then(setGuides, (err: unknown) => setError(errorText(err)))
  }
  useEffect(reload, [])
  return { guides, error, reload }
}

export default function GuidesPage({ tabId, guideId }: GuidesPageProps): ReactElement {
  const { guides, error, reload } = useGuides()
  const open = (id: string | null): void => void atelier.nav.go(tabId, guideUrl(id ?? undefined))
  const header = <PageHeader title={t('firstRun.guides.title')} description={t('firstRun.guides.description')} />

  if (error) {
    return (
      <DestinationFrame label={t('firstRun.guidesPage.guides')}>
        {header}
        <PageError title={t('firstRun.guidesPage.guidesCouldnTLoad')} message={error} onRetry={reload} />
      </DestinationFrame>
    )
  }
  if (!guides) {
    return (
      <DestinationFrame label={t('firstRun.guidesPage.guides')}>
        {header}
        <PageSkeleton label={t('firstRun.guidesPage.loadingGuides')} rows={4} />
      </DestinationFrame>
    )
  }
  const guide = guideId ? guides.find((g) => g.id === guideId) : null
  if (guideId && !guide) {
    return (
      <DestinationFrame label={t('firstRun.guidesPage.guides')}>
        {header}
        <EmptyState title={t('firstRun.guidesPage.thatGuideIsnT')} description={t('firstRun.guidesPage.itMayHaveBeen')} action={<Button variant="secondary" onClick={() => open(null)}>{t('firstRun.guidesPage.allGuides')}</Button>} />
      </DestinationFrame>
    )
  }
  return guide ? <GuideDetail guide={guide} onBack={() => open(null)} /> : <GuideList guides={guides} header={header} onOpen={open} />
}

// ── the Guides gallery ── category chips with counts, then one shelf per
// category: a heading, round previous/next arrows and a paging strip of
// book cards (about 450 ms, ease-in-out; the centre card grows, the edge
// cards fade). Searching shows the matches as a plain grid.

const CATEGORY_KEYS: Record<GuideCategory, MessageKey> = {
  basics: 'galleries.guides.category.basics',
  research: 'galleries.guides.category.research',
  productivity: 'galleries.guides.category.productivity',
  meetings: 'galleries.guides.category.meetings',
  shopping: 'galleries.guides.category.shopping',
  travel: 'galleries.guides.category.travel',
  writing: 'galleries.guides.category.writing',
  everyday: 'galleries.guides.category.everyday',
}

const CATEGORY_ICONS: Record<GuideCategory, ReactElement> = {
  basics: <Compass aria-hidden />,
  research: <BookOpenText aria-hidden />,
  productivity: <ListChecks aria-hidden />,
  meetings: <Users aria-hidden />,
  shopping: <ShoppingBag aria-hidden />,
  travel: <Plane aria-hidden />,
  writing: <PenLine aria-hidden />,
  everyday: <House aria-hidden />,
}

const CATEGORY_ORDER = GUIDE_CATEGORIES.map((c) => c.id)
const isCategory = (id: string): id is GuideCategory => (CATEGORY_ORDER as readonly string[]).includes(id)

type Translate = ReturnType<typeof useT>

function categoryName(td: Translate, id: string): string {
  return isCategory(id) ? td(CATEGORY_KEYS[id]) : (CATEGORY_LABEL[id] ?? id)
}

function bundleSummary(td: Translate, bundle: Guide['bundle']): string {
  if (!bundle) return ''
  const parts: string[] = []
  if (bundle.skills.length) parts.push(td('galleries.guides.bundle.skills', { count: bundle.skills.length }))
  if (bundle.routines.length) parts.push(td('galleries.guides.bundle.routines', { count: bundle.routines.length }))
  if (bundle.connectors.length) parts.push(td('galleries.guides.bundle.apps', { count: bundle.connectors.length }))
  return parts.join(' · ')
}

function GuideList({ guides, header, onOpen }: { guides: Guide[]; header: ReactElement; onOpen(id: string): void }): ReactElement {
  const td = useT()
  const [category, setCategory] = useState<Category>('all')
  const [query, setQuery] = useState('')
  const chips = useMemo(() => categoryCounts(CATEGORY_ORDER, guides), [guides])
  const shown = useMemo(() => filterGuides(guides, { category, query }), [guides, category, query])
  const searching = query.trim() !== ''
  const shelves = CATEGORY_ORDER.filter((c) => category === 'all' || c === category)
    .map((c) => ({ id: c, items: shown.filter((g) => g.category === c) }))
    .filter((shelf) => shelf.items.length > 0)
  return (
    <DestinationFrame label={td('galleries.guides.label')}>
      {header}
      <DestinationToolbar search={{ value: query, onChange: setQuery, placeholder: t('firstRun.guides.search') }} />
      <div className="gd-chips" role="group" aria-label={td('galleries.guides.categories')}>
        {chips.map((c) => (
          <button key={c.id} type="button" className={cx('gd-chip', category === c.id && 'gd-chip--on')} aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
            <span className="gd-chip__label">{c.id === 'all' ? td('galleries.guides.all') : categoryName(td, c.id)}</span>
            <span className="gd-chip__count">{c.count}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyState
          title={td('galleries.guides.noMatch')}
          description={td('galleries.guides.noMatch.description')}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setQuery('')
                setCategory('all')
              }}
            >
              {td('galleries.guides.showAll')}
            </Button>
          }
        />
      ) : searching ? (
        <ul className="gd-grid" aria-label={td('galleries.guides.results')}>
          {shown.map((g) => (
            <li key={g.id}>
              <button type="button" className="gd-card" onClick={() => onOpen(g.id)}>
                <span className="gd-card__meta">
                  <span>{categoryName(td, g.category)}</span>
                  <span className="gd-card__time">
                    <Clock aria-hidden /> {td('galleries.guides.minutes', { n: g.minutes })}
                  </span>
                </span>
                <span className="gd-card__title">{g.title}</span>
                <span className="gd-card__summary">{g.summary}</span>
                {g.bundle && (
                  <span className="gd-card__bundle">
                    <Sparkles aria-hidden /> {bundleSummary(td, g.bundle)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        shelves.map((shelf) => <GuideShelf key={shelf.id} id={shelf.id} title={categoryName(td, shelf.id)} guides={shelf.items} onOpen={onOpen} />)
      )}
    </DestinationFrame>
  )
}

/** A book card's width and the gap between cards (px); the centre card is drawn larger in CSS. */
const BOOK_WIDTH = 206
const BOOK_GAP = 16
const BOOK_PITCH = BOOK_WIDTH + BOOK_GAP

function GuideShelf({ id, title, guides, onOpen }: { id: GuideCategory; title: string; guides: Guide[]; onOpen(id: string): void }): ReactElement {
  const td = useT()
  const view = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [offset, setOffset] = useState(0)
  // Where an arrow press is heading while the view still glides there, so a quick second press goes one further.
  const aim = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = view.current
    if (!el) return
    setWidth(el.clientWidth)
    // The view is a real scroller (wheel, trackpad, arrows, focus); when a scroll settles it lands on a whole card.
    const onEnd = (): void => {
      aim.current = null
      const snapped = Math.min(Math.round(el.scrollLeft / BOOK_PITCH) * BOOK_PITCH, el.scrollWidth - el.clientWidth)
      if (Math.abs(snapped - el.scrollLeft) > 1) el.scrollTo({ left: snapped })
    }
    el.addEventListener('scrollend', onEnd)
    if (typeof ResizeObserver === 'undefined') return () => el.removeEventListener('scrollend', onEnd)
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? el.clientWidth))
    observer.observe(el)
    return () => {
      observer.disconnect()
      el.removeEventListener('scrollend', onEnd)
    }
  }, [])
  const viewport = width || BOOK_WIDTH * 3
  const layout = carouselLayout({ count: guides.length, viewport, card: BOOK_WIDTH, gap: BOOK_GAP, offset })
  // Room after the last card so it can scroll to the middle slot, as the arrows allow.
  const tail = Math.max(0, layout.maxOffset * layout.pitch + viewport + BOOK_GAP - guides.length * layout.pitch)
  const goTo = (next: number): void => {
    setOffset(next)
    const el = view.current
    const left = next * layout.pitch
    if (!el || Math.abs(el.scrollLeft - left) <= 1) return
    aim.current = next
    el.scrollTo({ left })
  }
  const step = (delta: -1 | 1): void => goTo(stepCarousel({ offset: aim.current ?? layout.offset, maxOffset: layout.maxOffset }, delta))
  const headingId = `gd-shelf-${id}`
  // ←/→ move between the cards; focus brings a card to the middle.
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const cards = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('.gd-book')]
    const at = cards.indexOf(document.activeElement as HTMLButtonElement)
    const next = cards[at + (e.key === 'ArrowRight' ? 1 : -1)]
    if (at < 0 || !next) return
    e.preventDefault()
    next.focus({ preventScroll: true })
  }
  return (
    <section className="gd-shelf" aria-labelledby={headingId}>
      <div className="gd-shelf__head">
        <h2 id={headingId} className="gd-shelf__title">
          {title}
        </h2>
        {layout.maxOffset > 0 && (
          <span className="gd-shelf__arrows">
            <button type="button" className="gd-arrow" aria-label={td('galleries.guides.prev', { section: title })} disabled={layout.offset === 0} onClick={() => step(-1)}>
              <ChevronLeft aria-hidden />
            </button>
            <button type="button" className="gd-arrow" aria-label={td('galleries.guides.next', { section: title })} disabled={layout.offset >= layout.maxOffset} onClick={() => step(1)}>
              <ChevronRight aria-hidden />
            </button>
          </span>
        )}
      </div>
      <div
        className="gd-shelf__view"
        ref={view}
        role="group"
        aria-roledescription={td('galleries.guides.carousel')}
        aria-labelledby={headingId}
        data-more={layout.offset < layout.maxOffset ? '' : undefined}
        onScroll={(e) => {
          if (aim.current === null) setOffset(Math.round(e.currentTarget.scrollLeft / layout.pitch))
        }}
      >
        <ul className="gd-shelf__strip" style={{ gap: BOOK_GAP, paddingInlineEnd: tail }} onKeyDown={onKeyDown}>
          {guides.map((g, i) => (
            <li key={g.id} className="gd-shelf__slot" data-role={layout.roles[i]} style={{ width: BOOK_WIDTH }}>
              <button
                type="button"
                className="gd-book"
                data-category={g.category}
                onClick={() => onOpen(g.id)}
                onFocus={(e) => {
                  // Only keyboard focus pages the strip; a press must land where it was aimed.
                  if (e.currentTarget.matches(':focus-visible')) goTo(offsetFor(layout, i))
                }}
              >
                <span className="gd-book__spine" aria-hidden />
                <span className="gd-book__kicker">
                  {isCategory(g.category) ? CATEGORY_ICONS[g.category] : null}
                  {title}
                </span>
                <span className="gd-book__title">{g.title}</span>
                <span className="gd-book__art" aria-hidden />
                <span className="gd-book__foot">
                  <Clock aria-hidden />
                  {td('galleries.guides.minutes', { n: g.minutes })}
                  {g.bundle && <span className="gd-book__bundle">{bundleSummary(td, g.bundle)}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function GuideDetail({ guide, onBack }: { guide: Guide; onBack(): void }): ReactElement {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GuideTryResult | null>(null)
  const tryIt = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await call('guides', 'tryIt', guide.id)
      setResult(r)
      if (r.chatId) await call('pages', 'open', chatUrl(r.chatId))
      else toast.show({ message: tryMessage(r), tone: 'success' })
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const b = guide.bundle
  return (
    <DestinationFrame label={guide.title}>
      <div className="gd-detail">
        <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack}>{t('firstRun.guidesPage.allGuides')}</Button>
        <div className="gd-detail__meta">
          <Badge tone="neutral">{categoryName(t, guide.category)}</Badge>
          <span className="gd-card__time">
            <Clock aria-hidden /> {t('firstRun.guidesPage.minRead', { minutes: guide.minutes })}
          </span>
        </div>
        <GuideText source={guide.body} />
        {b && (
          <section className="gd-bundle" aria-labelledby="gd-bundle-title">
            <h2 id="gd-bundle-title">{t('firstRun.guidesPage.inThisBundle')}</h2>
            <ul>
              {b.skills.map((s) => (
                <li key={`s-${s}`}>
                  <WandSparkles aria-hidden /> <span className="sp-mono">/{s}</span> <span className="gd-bundle__note">{t('firstRun.guidesPage.builtInSkill')}</span>
                </li>
              ))}
              {b.routines.map((r) => (
                <li key={`r-${r.name}`}>
                  <CalendarClock aria-hidden /> {r.name} <span className="gd-bundle__note">{t('firstRun.guidesPage.routineNote')}</span>
                </li>
              ))}
              {b.connectors.map((c) => (
                <li key={`c-${c}`}>
                  <Plug aria-hidden /> {c} <span className="gd-bundle__note">{t('firstRun.guidesPage.suggestedApp')}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {guide.tryIt !== 'open' && (
          <div className="gd-detail__actions">
            <Button variant="primary" loading={busy} onClick={() => void tryIt()}>{guide.tryIt === 'start-chat' ? t('firstRun.guidesPage.tryItInA') : result ? t('firstRun.guidesPage.installAgain') : t('firstRun.guidesPage.tryIt')}</Button>
          </div>
        )}
        {result && !result.chatId && (
          <div className="gd-result" role="status">
            <p>{tryMessage(result)}</p>
            <div className="gd-result__links">
              {result.routines.map((id) => (
                <Button key={id} size="sm" variant="secondary" onClick={() => void call('pages', 'open', routineUrl(id))}>{t('firstRun.guidesPage.reviewTheRoutine')}</Button>
              ))}
              {result.connectorSuggestions.map((id) => (
                <Button key={id} size="sm" variant="secondary" icon={<Plug />} onClick={() => void call('pages', 'open', connectorConnectUrl(id))}>{t('firstRun.guidesPage.connect', { id })}</Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </DestinationFrame>
  )
}

function tryMessage(r: GuideTryResult): string {
  const parts: string[] = []
  if (r.installedSkills.length) parts.push(t('firstRun.guidesPage.readyToUse', { skills: r.installedSkills.map((s) => `/${s}`).join(', ') }))
  if (r.routines.length) parts.push(t('firstRun.guidesPage.routinesAdded', { count: r.routines.length }))
  if (r.connectorSuggestions.length) parts.push(t('firstRun.guidesPage.appsToConnect', { count: r.connectorSuggestions.length }))
  return parts.length ? t('firstRun.guidesPage.tryDone', { parts: parts.join('; ') }) : t('firstRun.guidesPage.nothingNew')
}
