/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex://history: the pages you visited, grouped by day and searchable, in the
// same frame as the other destination pages. Rows open here, ⌘-click and a
// middle click open in the background, and ✕ removes a page from history
// (and from the command bar's suggestions). With the timeline flag on, List
// and Timeline switch views; ?view=timeline (with ?scope= and ?date=) shows
// your browsing by day (the activity timeline, which used to be a Workspace section).
import { Suspense, lazy, useMemo, useState, type MouseEvent, type ReactElement } from 'react'
import { History, X } from 'lucide-react'
import { localDayKey } from '@shared/activity'
import { isFlagOn } from '@shared/flags'
import type { HistoryItem } from '@shared/services'
import { displayHost } from '@shared/domains'
import { historyView, timelineUrl } from '../activity/logic'
import { apex, call, errorText } from '../api'
import { useSettingsView } from '../companion-card/useLoaded'
import { useT } from '../i18n/useT'
import { Button, EmptyState, IconButton, RelativeTime, SegmentedControl, SkeletonRows, showContextMenu, useConfirm, useToast } from '../ui'
import { useResource } from '../settings/data'
import { DestinationFrame, ListState } from '../settings/destinations/common'
import { ListFrame, PageHeader, SearchField } from '../settings/kit'
import { groupByDay, siteInitial } from '../settings/logic/collections'

export const HISTORY_LIMIT = 500

const TimelineSection = lazy(() => import('./history/timeline/TimelineSection'))

function SiteIcon({ url, title }: { url: string; title?: string }): ReactElement {
  return (
    <span className="sp-favicon" aria-hidden>
      {siteInitial(url, title)}
    </span>
  )
}

/** ⌘-click and a middle click open in a background tab; ⇧⌘ in front; a plain click opens here. */
export function openFrom(e: MouseEvent, tabId: string, url: string): void {
  const mod = e.metaKey || e.ctrlKey
  if (mod || e.button === 1) void apex.tabs.create(url, { background: !(mod && e.shiftKey), afterId: tabId })
  else void apex.nav.go(tabId, url)
}

export function HistoryPage({ tabId, url = '' }: { tabId: string; url?: string }): ReactElement {
  const t = useT()
  const settings = useSettingsView()
  const timelineOn = isFlagOn(settings?.flags ?? {}, 'timeline')
  if (timelineOn && historyView(url.split('?')[1] ?? '') === 'timeline')
    return (
      <DestinationFrame label={t('address.page.history')} variant="fluid">
        <div className="hist-timeline">
          <PageHeader title={t('address.page.history')} description={t('memory.timeline.description')} actions={<ViewSwitch tabId={tabId} view="timeline" />} />
          <Suspense fallback={<SkeletonRows rows={6} label={t('address.page.historyTimeline')} />}>
            <TimelineSection tabId={tabId} url={url} heading={false} />
          </Suspense>
        </div>
      </DestinationFrame>
    )
  return <HistoryList tabId={tabId} timelineOn={timelineOn} />
}

/** The switch between the list and the timeline, beside the header's actions. */
function ViewSwitch({ tabId, view }: { tabId: string; view: 'list' | 'timeline' }): ReactElement {
  const t = useT()
  return (
    <SegmentedControl<'list' | 'timeline'>
      label={t('address.page.historyView')}
      size="sm"
      value={view}
      onChange={(next) => void apex.nav.go(tabId, next === 'timeline' ? timelineUrl('day', localDayKey(Date.now())) : 'apex://history')}
      options={[
        { value: 'list', label: t('address.page.historyList') },
        { value: 'timeline', label: t('address.page.historyTimeline') },
      ]}
    />
  )
}

function HistoryList({ tabId, timelineOn }: { tabId: string; timelineOn: boolean }): ReactElement {
  const t = useT()
  const [query, setQuery] = useState('')
  const history = useResource(() => call('history', 'search', query, HISTORY_LIMIT), query, { keep: true })
  const confirm = useConfirm()
  const toast = useToast()
  const items = history.data ?? []
  const groups = useMemo(() => (query ? [{ label: t('address.page.results'), items }] : groupByDay(items, (h: HistoryItem) => h.lastVisit)), [items, query, t])

  const clearAll = async (): Promise<void> => {
    const ok = await confirm({ title: t('address.page.clearConfirm'), confirmLabel: t('address.page.clear'), cancelLabel: t('address.page.cancel'), destructive: true })
    if (!ok) return
    try {
      await call('history', 'clear')
      await history.reload()
      toast.show({ tone: 'success', message: t('address.page.historyCleared') })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  const remove = async (url: string): Promise<void> => {
    try {
      await call('history', 'remove', url)
      history.set(items.filter((h) => h.url !== url))
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  return (
    <DestinationFrame label={t('address.page.history')}>
      <PageHeader
        title={t('address.page.history')}
        description={t('address.page.historyDescription')}
        actions={
          <>
            {timelineOn && <ViewSwitch tabId={tabId} view="list" />}
            <Button variant="secondary" disabled={!history.data || (history.data.length === 0 && !query)} onClick={() => void clearAll()}>
              {t('address.page.clearHistory')}
            </Button>
          </>
        }
      />
      <div className="sp-toolbar">
        <SearchField value={query} onChange={setQuery} placeholder={t('address.page.historySearch')} />
      </div>
      <ListState
        // Search runs in main, so with a query an empty result means no matches rather than no history.
        items={history.data === null ? null : query ? [query] : history.data}
        shown={items.length}
        error={history.error}
        onRetry={history.reload}
        loadingLabel={t('address.page.loading')}
        avatar
        onClearFilters={query ? () => setQuery('') : undefined}
        empty={<EmptyState icon={<History />} title={t('address.page.noHistory')} description={t('address.page.noHistoryBody')} />}
      >
        {groups.map((group) => (
          <section key={group.label} className="sp-group" aria-label={group.label}>
            <h2 className="sp-group__label">{group.label}</h2>
            <ListFrame>
              {group.items.map((h) => (
                <div
                  key={h.url}
                  className="sp-item"
                  onContextMenu={(e) =>
                    void showContextMenu(e, [
                      { id: 'open', label: t('address.bookmarks.open') },
                      { id: 'new-tab', label: t('address.bookmarks.openNewTab') },
                      { id: 'background', label: t('address.bookmarks.openBackground') },
                      { id: 'sep', label: '', type: 'separator' },
                      { id: 'remove', label: t('address.page.removeFromHistory') },
                    ]).then((id) => {
                      if (id === 'open') void apex.nav.go(tabId, h.url)
                      else if (id === 'new-tab') void apex.tabs.create(h.url, { afterId: tabId })
                      else if (id === 'background') void apex.tabs.create(h.url, { afterId: tabId, background: true })
                      else if (id === 'remove') void remove(h.url)
                    })
                  }
                >
                  <SiteIcon url={h.url} title={h.title} />
                  <button type="button" className="sp-item__main" onClick={(e) => openFrom(e, tabId, h.url)} onAuxClick={(e) => e.button === 1 && openFrom(e, tabId, h.url)}>
                    <span className="sp-item__title">
                      <span className="sp-item__title-text">{h.title || h.url}</span>
                    </span>
                    <span className="sp-item__sub">{displayHost(h.url).display || h.url}</span>
                  </button>
                  <span className="sp-item__meta">{query ? <RelativeTime value={h.lastVisit} /> : new Date(h.lastVisit).toLocaleTimeString(undefined, { timeStyle: 'short' })}</span>
                  <div className="sp-item__actions sp-item__actions--reveal">
                    <IconButton size="sm" label={t('address.page.removeEntry', { title: h.title || h.url })} icon={<X />} onClick={() => void remove(h.url)} />
                  </div>
                </div>
              ))}
            </ListFrame>
          </section>
        ))}
        {items.length >= HISTORY_LIMIT && <p className="sp-section__note">{t('address.page.historyLimit', { count: HISTORY_LIMIT })}</p>}
      </ListState>
    </DestinationFrame>
  )
}
