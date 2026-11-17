/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Search everything, atelier://workspace/search?q=: past chats
// (private ones never), memory notes, history and bookmarks of this
// profile, and files in shared folders, companions' files and the Library.
// Results are grouped by source, ranked by relevance with a recency bonus,
// with highlighted snippets. What is searched is typed in the hub's own
// field (Search everything, above the tabs). ↑ and ↓ move between results,
// and ↑ from the first goes back to the field.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import { ArrowLeft, Bookmark, Brain, FileText, Globe, MessageSquare, RefreshCw, Search } from 'lucide-react'
import { SEARCH_SOURCES, plainSnippet, snippetParts, type SearchHit, type SearchSource } from '@shared/workspace'
import { call, errorText } from '../../../api'
import { useT } from '../../../i18n/useT'
import { Button, EmptyState, ErrorState, IconButton, RelativeTime, SegmentedControl, SkeletonRows, Spinner, formatRelative, useNow } from '../../../ui'
import { useFolders, useIndexState } from '../../../workspace/data'
import { SectionHead } from '../../../workspace/kit'
import { groupHits } from '../../../workspace/logic'
import { fail, goWorkspace, openHit } from '../../../workspace/open'
import type { WorkspaceSectionProps } from '../sections'

const PAGE = 30
const ALL = 'all'
type SourceFilter = SearchSource | typeof ALL

const SOURCE_ICON: Record<SearchSource, ReactElement> = {
  chats: <MessageSquare aria-hidden />,
  memory: <Brain aria-hidden />,
  history: <Globe aria-hidden />,
  bookmarks: <Bookmark aria-hidden />,
  files: <FileText aria-hidden />,
}

type Results = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; hits: SearchHit[]; total: number }

/** The hub's search field, where ↑ from the first result goes. */
function focusField(): void {
  document.querySelector<HTMLInputElement>('.ws-top .ws-search input')?.focus()
}

export default function SearchSection({ query = null }: WorkspaceSectionProps): ReactElement {
  const t = useT()
  const now = useNow()
  const text = query ?? ''
  const [debounced, setDebounced] = useState(text.trim())
  const [source, setSource] = useState<SourceFilter>(ALL)
  const [limit, setLimit] = useState(PAGE)
  // With a query in the address, its results load straight away (never the empty "type a few words" first).
  const [results, setResults] = useState<Results>(text.trim() ? { status: 'loading' } : { status: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const index = useIndexState()
  const folders = useFolders()
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text.trim()), 180)
    return () => clearTimeout(timer)
  }, [text])
  useEffect(() => setLimit(PAGE), [debounced, source])

  useEffect(() => {
    if (!debounced) {
      setResults({ status: 'idle' })
      return
    }
    let live = true
    setResults((r) => (r.status === 'ready' ? r : { status: 'loading' }))
    Promise.resolve(call('search', 'query', debounced, { ...(source === ALL ? {} : { sources: [source] }), limit }))
      .then((r) => live && setResults({ status: 'ready', hits: r.hits, total: r.total }))
      .catch((err: unknown) => live && setResults({ status: 'error', message: errorText(err) }))
    return () => {
      live = false
    }
  }, [debounced, source, limit, attempt, index?.updatedAt])

  const groups = useMemo(() => (results.status === 'ready' ? groupHits(results.hits) : []), [results])

  const rebuild = (): void => {
    Promise.resolve(call('search', 'rebuild')).catch(fail)
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('.ws-hit') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowUp' && at <= 0) {
      focusField()
      e.preventDefault()
      return
    }
    items[Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))]?.focus()
    e.preventDefault()
  }

  const open = (hit: SearchHit, e: MouseEvent): void => openHit(hit, folders.data ?? [], { newTab: e.metaKey || e.ctrlKey })

  const status = index?.building ? (
    <span className="ws-index" role="status">
      <Spinner size={12} />
      {index.total > 0 ? t('workspace.search.indexing', { done: index.done, total: index.total }) : t('workspace.search.rebuilding')}
    </span>
  ) : index?.updatedAt ? (
    <span className="ws-index">{t('workspace.search.updated', { time: formatRelative(index.updatedAt, now) })}</span>
  ) : null

  let body: ReactElement
  if (results.status === 'idle') body = <EmptyState icon={<Search />} title={t('workspace.search.emptyTitle')} description={t('workspace.search.emptyText')} />
  else if (results.status === 'loading') body = <SkeletonRows rows={6} avatar label={t('workspace.section.search')} />
  else if (results.status === 'error') body = <ErrorState message={results.message} title={t('workspace.loadError')} onRetry={() => setAttempt((n) => n + 1)} />
  else if (results.hits.length === 0) body = <EmptyState icon={<Search />} title={t('workspace.search.noResults', { query: debounced })} description={t('workspace.search.noResultsText')} />
  else
    body = (
      <div ref={list} className="ws-results" onKeyDown={onListKey}>
        {groups.map((g) => (
          <section key={g.source} className="ws-results__group" aria-labelledby={`ws-group-${g.source}`}>
            <h3 id={`ws-group-${g.source}`}>{t(`workspace.search.source.${g.source}`)}</h3>
            <ul role="list" className="ws-plain-list">
              {g.hits.map((hit) => (
                <li key={hit.id}>
                  <button type="button" className="ws-hit" onClick={(e) => open(hit, e)} aria-label={`${hit.title}. ${plainSnippet(hit.snippet)}`}>
                    <span className="ws-name__tile">{SOURCE_ICON[hit.source]}</span>
                    <span className="ws-hit__body">
                      <span className="ws-hit__title">{hit.title}</span>
                      {hit.snippet && (
                        <span className="ws-hit__snippet">
                          {snippetParts(hit.snippet).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                        </span>
                      )}
                    </span>
                    <RelativeTime value={hit.at} style="short" className="ws-hit__time" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {results.total > results.hits.length && (
          <div>
            <Button onClick={() => setLimit((n) => Math.min(200, n + PAGE))} disabled={limit >= 200}>
              {t('workspace.search.showMore')}
            </Button>
          </div>
        )}
      </div>
    )

  return (
    <>
      <SectionHead
        lead={<IconButton label={t('workspace.back')} icon={<ArrowLeft />} onClick={() => goWorkspace('home')} />}
        title={t('workspace.section.search')}
        subtitle={t('workspace.search.subtitle')}
        actions={
          <>
            {status}
            <Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={rebuild} disabled={index?.building}>
              {t('workspace.search.rebuild')}
            </Button>
          </>
        }
      />
      <div className="ws-card__body">
        <div className="ws-toolbar">
          <SegmentedControl<SourceFilter>
            label={t('workspace.search.placeholder')}
            size="sm"
            value={source}
            onChange={setSource}
            options={[{ value: ALL, label: t('workspace.search.all') }, ...SEARCH_SOURCES.map((s) => ({ value: s, label: t(`workspace.search.source.${s}`) }))]}
          />
          {results.status === 'ready' && results.total > 0 && (
            <span className="ws-muted" role="status" aria-live="polite">
              {t('workspace.search.count', { count: results.total })}
            </span>
          )}
        </div>
        {body}
      </div>
    </>
  )
}
