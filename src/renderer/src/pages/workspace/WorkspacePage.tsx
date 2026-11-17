/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Workspace hub (apex://workspace[/<section>[/<id>]]): one
// centred column with the title and Search everything, four tabs (Home,
// Projects, Files, Apps) with Recently deleted at the end of their row, and
// the section below. Tables show under Files; Search and Recently deleted
// under no tab; an old Timeline address goes to History. It arrives without
// entrance motion. The command bar's space switch for an empty space lands
// here as ?space=.
import { Component, Suspense, useEffect, useRef, useState, type ErrorInfo, type ReactElement, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { internalQuery } from '@shared/url'
import { WORKSPACE_TABS, workspaceTabOf, type WorkspaceSection } from '@shared/workspace'
import { call } from '../../api'
import { timelineRedirect } from '../../activity/logic'
import { useT } from '../../i18n/useT'
import { Button, ErrorState, SkeletonRows, TabList, TabPanel } from '../../ui'
import { useTrashCount } from '../../workspace/data'
import { SearchBox } from '../../workspace/kit'
import { fail, goSearch, goWorkspace } from '../../workspace/open'
import '../../workspace/projectMenuRunner'
import { sectionPage } from './sections'
import '../../workspace/workspace.css'

export interface WorkspacePageProps {
  tabId: string
  section: WorkspaceSection | null
  itemId: string | null
  /** The page's address, for ?q= and ?space=. */
  url?: string
}

const TABS_ID = 'ws-tabs'

/** Keeps a section that fails to load (or throws) inside the page, with Retry. */
class SectionBoundary extends Component<{ children: ReactNode; title: string; retry: string }, { error: string | null; attempt: number }> {
  state = { error: null as string | null, attempt: 0 }
  static getDerivedStateFromError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  componentDidCatch(_err: unknown, _info: ErrorInfo): void {}
  render(): ReactNode {
    if (this.state.error !== null)
      return (
        <div className="ws-card__body">
          <ErrorState title={this.props.title} message={this.state.error} retryLabel={this.props.retry} onRetry={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))} />
        </div>
      )
    return <div key={this.state.attempt} className="ws-section">{this.props.children}</div>
  }
}

export default function WorkspacePage({ tabId, section, itemId, url = '' }: WorkspacePageProps): ReactElement {
  const t = useT()
  const current = section ?? 'home'
  const tab = workspaceTabOf(current)
  const Section = sectionPage(current, itemId)
  const trashCount = useTrashCount()
  const query = internalQuery(url, 'q')
  const space = internalQuery(url, 'space')
  // On the search view the field holds the query and typing searches as you go; elsewhere Enter goes there.
  const [text, setText] = useState(current === 'search' ? (query ?? '') : '')
  useEffect(() => setText(current === 'search' ? (query ?? '') : ''), [current, query])

  // The command bar's switch to an empty space (spaceSwitchUrl in main).
  const switched = useRef<string | null>(null)
  useEffect(() => {
    if (!space || switched.current === url) return
    switched.current = url
    Promise.resolve(call('spaces', 'switchTo', space === 'none' ? null : space)).catch(fail)
  }, [space, url])

  // The timeline moved to History; an old address (a bookmark, the command bar) goes there.
  useEffect(() => {
    if (current === 'timeline') Promise.resolve(call('pages', 'open', timelineRedirect(url, Date.now()))).catch(fail)
  }, [current, url])

  const body = Section ? (
    <SectionBoundary key={current} title={t('workspace.loadError')} retry={t('workspace.retry')}>
      <Suspense fallback={<SkeletonRows rows={6} label={tab ? t(`workspace.section.${tab}`) : t('workspace.title')} />}>
        <Section itemId={itemId} query={current === 'search' ? text : query} tabId={tabId} url={url} />
      </Suspense>
    </SectionBoundary>
  ) : (
    <SkeletonRows rows={6} label={t('workspace.title')} />
  )

  return (
    <div className="ws-page" data-section={current}>
      <div className="ws-frame">
        <header className="ws-top">
          <h1 className="ws-top__title">{t('workspace.title')}</h1>
          <SearchBox
            className="ws-top__search"
            value={text}
            onChange={setText}
            placeholder={t('workspace.search.placeholder')}
            autoFocus={current === 'search' && !query}
            onEnter={() => {
              if (current !== 'search' && text.trim()) goSearch(text)
            }}
          />
        </header>
        <div className="ws-tabsrow">
          <TabList
            idPrefix={TABS_ID}
            label={t('workspace.nav.label')}
            value={tab ?? ''}
            activation="manual"
            onChange={(id) => goWorkspace(id as WorkspaceSection)}
            tabs={WORKSPACE_TABS.map((id) => ({ id, label: t(`workspace.section.${id}`) }))}
          />
          <Button size="sm" variant="ghost" className="ws-trash-link" icon={<Trash2 />} aria-current={current === 'trash' ? 'page' : undefined} onClick={() => goWorkspace('trash')}>
            {t('workspace.section.trash')}
            {trashCount !== null && trashCount > 0 && (
              <span className="ws-trash-link__count" aria-label={t('workspace.trash.count', { count: trashCount })}>
                {trashCount}
              </span>
            )}
          </Button>
        </div>
        <main className="ws-main">
          {tab ? (
            <TabPanel idPrefix={TABS_ID} tabId={tab} className="ws-main__panel">
              {body}
            </TabPanel>
          ) : (
            <div className="ws-main__panel">{body}</div>
          )}
        </main>
      </div>
    </div>
  )
}
