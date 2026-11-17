/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex://connectors[/<id>] (SK-13, SK-14): the connectors you added,
// your own servers and Apex's curated directory, with one search, status and
// category filters, and a confirmation banner for ?connect=<id> links. An id
// opens that connector's detail.
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { ChevronRight, Plug, Plus, SearchX } from 'lucide-react'
import { CONNECTOR_CATEGORIES, connectFromOf, connectorDetailUrl, connectRequestOf, type ConnectorCategory, type ConnectorV2, type DirectoryEntry } from '@shared/connectors'
import type { Connector } from '@shared/services'
import { apex, call } from '../api'
import { ConnectDialog } from '../connectors/ConnectFlow'
import { ConnectorDetail, healthDot, healthText } from '../connectors/ConnectorDetail'
import { ConnectorLogo } from '../connectors/ConnectorLogo'
import { localApprovalProps } from '../connectors/LocalApprovalDialog'
import { GROUP_PREVIEW, connectedCount, directoryGroups, filterActive, needsAttention, visibleRows, type DirectoryFilter, type StatusFilter } from '../connectors/logic/directory'
import '../connectors/connectors.css'
import { ConnectionBanner } from './errors/ConnectionBanner'
import { useT, type T } from '../i18n/useT'
import { DestinationFrame } from '../settings/destinations/common'
import { useConnectorDialogs } from '../settings/destinations/ConnectorEditor'
import { useLiveResource, useResource } from '../settings/data'
import { DestinationToolbar, Notice, PageError, PageHeader, PageSkeleton, TileGrid } from '../settings/kit'
import { Button, EmptyState, StatusDot, showMenu, useToast } from '../ui'

export interface ConnectorsPageProps {
  tabId: string
  /** apex://connectors/<id> opens that connector's detail. */
  itemId?: string | null
  /** The page's address, for ?connect=<directoryId>. */
  url?: string
}

const STATUS_KEYS: Record<StatusFilter, Parameters<T>[0]> = {
  all: 'connectors.filter.all',
  connected: 'connectors.filter.connected',
  attention: 'connectors.filter.attention',
  off: 'connectors.filter.off',
  available: 'connectors.filter.available',
}

const EMPTY_FILTER: DirectoryFilter = { query: '', status: 'all', category: 'all' }

export function ConnectorsPage({ tabId, itemId = null, url = '' }: ConnectorsPageProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const connectors = useLiveResource(() => call('connectors', 'list'), 'connectors', (e) => e.items)
  const directory = useResource(() => call('connectors', 'directory'))
  const dialogs = useConnectorDialogs()
  const [connecting, setConnecting] = useState<DirectoryEntry | null>(null)

  const entries = directory.data ?? []
  const list = connectors.data

  const afterConnect = (c: ConnectorV2): void => {
    setConnecting(null)
    toast.show({ tone: 'success', message: t('connectors.connect.done', { name: c.displayName }) })
    void apex.nav.go(tabId, connectorDetailUrl(c.id))
  }

  const addServer = async (el: HTMLElement | null, mode?: 'remote' | 'local' | 'json'): Promise<void> => {
    const result = await dialogs.openAdd(el, mode ? { mode } : {})
    const first = result?.saved[0]
    if (!result || !first) return
    toast.show({ tone: 'success', message: result.saved.length === 1 ? t('connectors.add.added', { name: first.name }) : t('connectors.add.imported', { count: result.saved.length }) })
    // Remote servers connect and list their tools now; local ones wait for approval of their command.
    for (const saved of result.saved) if (!saved.local) void call('connectors', 'check', saved.id).catch(() => undefined)
    void apex.nav.go(tabId, connectorDetailUrl(first.id))
    // One local server you just typed in: show its exact command now. Imported ones wait on their detail page.
    if (result.saved.length === 1 && first.local) {
      const saved = (await call('connectors', 'list')).find((c: Connector) => c.id === first.id)
      const data = saved ? localApprovalProps(saved) : null
      if (data) void dialogs.openApproval(null, data)
    }
  }

  let body: ReactElement
  if (itemId) {
    const connector = list?.find((c) => c.id === itemId)
    body =
      list === null ? (
        <PageSkeleton label={t('connectors.detail.loading')} rows={5} />
      ) : connector ? (
        <ConnectorDetail connector={connector} all={list} directory={entries} tabId={tabId} dialogs={dialogs} onConnectAnother={setConnecting} />
      ) : (
        <EmptyState
          icon={<Plug />}
          title={t('connectors.detail.gone')}
          action={
            <Button variant="secondary" onClick={() => void apex.nav.go(tabId, 'apex://connectors')}>
              {t('connectors.page.back')}
            </Button>
          }
        />
      )
  } else {
    body = (
      <Directory
        tabId={tabId}
        url={url}
        list={list}
        error={connectors.error ?? directory.error}
        onRetry={() => Promise.all([connectors.reload(), directory.reload()])}
        entries={entries}
        onConnect={setConnecting}
        onAdd={(el) => void addServer(el)}
      />
    )
  }

  return (
    <DestinationFrame label={t('connectors.page.title')}>
      {/* SS-06: offline, a countdown to the next check; back online, the lists reload. */}
      <ConnectionBanner onReconnect={() => void Promise.all([connectors.reload(), directory.reload()])} />
      {body}
      <ConnectDialog key={connecting?.id ?? 'none'} entry={connecting} onClose={() => setConnecting(null)} onConnected={afterConnect} />
      {dialogs.element}
    </DestinationFrame>
  )
}

interface DirectoryProps {
  tabId: string
  url: string
  list: Connector[] | null
  error: string | null
  onRetry(): Promise<unknown>
  entries: DirectoryEntry[]
  onConnect(entry: DirectoryEntry): void
  onAdd(el: HTMLElement | null): void
}

function Directory({ tabId, url, list, error, onRetry, entries, onConnect, onAdd }: DirectoryProps): ReactElement {
  const t = useT()
  const [filter, setFilter] = useState<DirectoryFilter>(EMPTY_FILTER)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [banner, setBanner] = useState<string | null>(null)
  const [bannerFrom, setBannerFrom] = useState<string | null>(null)

  // ?connect=<id>[&from=<app>]: a banner asks first; nothing connects from a link or an app alone.
  useEffect(() => {
    setBanner(connectRequestOf(url))
    setBannerFrom(connectFromOf(url))
  }, [url])
  const bannerEntry = banner ? entries.find((e) => e.id === banner) : undefined
  const dismissBanner = (): void => {
    setBanner(null)
    if (connectRequestOf(url)) void apex.nav.go(tabId, 'apex://connectors')
  }

  const groups = useMemo(() => (list ? directoryGroups(list, entries, filter) : []), [list, entries, filter])
  const count = list ? connectedCount(list) : 0
  const searching = filter.query.trim() !== ''

  const openFilter = async (anchor: HTMLElement): Promise<void> => {
    const picked = await showMenu(
      [
        { id: 'status-label', label: t('connectors.filter.status'), enabled: false },
        ...(['all', 'connected', 'attention', 'off', 'available'] as const).map((s) => ({ id: `status:${s}`, label: t(STATUS_KEYS[s]), type: 'radio' as const, checked: filter.status === s })),
        { id: 'sep', label: '', type: 'separator' as const },
        {
          id: 'category',
          label: t('connectors.filter.category'),
          submenu: [
            { id: 'category:all', label: t('connectors.filter.allCategories'), type: 'radio' as const, checked: filter.category === 'all' },
            ...CONNECTOR_CATEGORIES.map((c) => ({ id: `category:${c}`, label: t(`connectors.category.${c}`), type: 'radio' as const, checked: filter.category === c })),
          ],
        },
      ],
      anchor,
    )
    if (picked?.startsWith('status:')) setFilter((f) => ({ ...f, status: picked.slice(7) as StatusFilter }))
    else if (picked?.startsWith('category:')) setFilter((f) => ({ ...f, category: picked.slice(9) as 'all' | ConnectorCategory }))
  }

  const header = (
    <PageHeader
      title={t('connectors.page.title')}
      description={list === null ? t('connectors.page.lede') : count === 1 ? t('connectors.page.ledeOne') : t('connectors.page.ledeCount', { count })}
      actions={
        <Button variant="primary" icon={<Plus />} onClick={(e) => onAdd(e.currentTarget)}>
          {t('connectors.page.add')}
        </Button>
      }
    />
  )

  if (error && list === null) return <>{header}<PageError title={t('connectors.page.loadFailed')} message={error} onRetry={onRetry} /></>

  return (
    <>
      {header}
      <DestinationToolbar
        fullWidth
        search={{ value: filter.query, onChange: (query) => setFilter((f) => ({ ...f, query })), placeholder: t('connectors.page.search') }}
        filter={{ label: t('connectors.page.filter'), active: filterActive(filter), onOpen: (el) => void openFilter(el) }}
      />
      {banner && (
        <div className="cx-banner">
          {bannerEntry ? (
            <Notice
              tone="info"
              onDismiss={dismissBanner}
              action={
                <span className="cx-row">
                  <Button size="sm" variant="secondary" onClick={dismissBanner}>
                    {t('connectors.banner.notNow')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      onConnect(bannerEntry)
                      dismissBanner()
                    }}
                  >
                    {t('connectors.connect.add')}
                  </Button>
                </span>
              }
            >
              <strong>{t('connectors.banner.title', { name: bannerEntry.name })}</strong>{' '}
              {bannerFrom ? t('connectors.banner.bodyFrom', { name: bannerEntry.name, from: bannerFrom }) : t('connectors.banner.body', { name: bannerEntry.name })}
            </Notice>
          ) : entries.length > 0 ? (
            <Notice tone="warning" onDismiss={dismissBanner}>
              {t('connectors.banner.unknown')}
            </Notice>
          ) : null}
        </div>
      )}
      {list === null ? (
        <PageSkeleton label={t('connectors.page.loading')} rows={6} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<SearchX />}
          title={t('connectors.page.noMatch')}
          description={t('connectors.page.noMatchHint')}
          action={
            <Button variant="secondary" onClick={() => setFilter(EMPTY_FILTER)}>
              {t('connectors.page.clearFilters')}
            </Button>
          }
        />
      ) : (
        <div className="cx-groups">
          {groups.map((group) => {
            const title = group.id === 'connected' ? t('connectors.group.connected') : group.id === 'custom' ? t('connectors.group.custom') : t(`connectors.category.${group.id}`)
            const isOpen = expanded.has(group.id)
            const headingId = `cx-group-${group.id}`
            const toggle = (): void =>
              setExpanded((prev) => {
                const next = new Set(prev)
                if (next.has(group.id)) next.delete(group.id)
                else next.add(group.id)
                return next
              })
            if (group.kind === 'connectors') {
              const rows = visibleRows(group.entries, isOpen, searching)
              return (
                <section key={group.id} className="cx-group" aria-labelledby={headingId}>
                  <h2 id={headingId} className="cx-group__title">
                    {title}
                  </h2>
                  <TileGrid label={title}>
                    {rows.shown.map((c) => (
                      <div role="listitem" key={c.id}>
                        <ConnectorTile connector={c} entries={entries} onOpen={() => void apex.nav.go(tabId, connectorDetailUrl(c.id))} />
                      </div>
                    ))}
                  </TileGrid>
                  <MoreButton hidden={rows.hidden} open={isOpen && !searching && group.entries.length > GROUP_PREVIEW} onToggle={toggle} />
                </section>
              )
            }
            const rows = visibleRows(group.entries, isOpen, searching)
            return (
              <section key={group.id} className="cx-group" aria-labelledby={headingId}>
                <h2 id={headingId} className="cx-group__title">
                  {title}
                </h2>
                <TileGrid label={title}>
                  {rows.shown.map((e) => (
                    <div role="listitem" key={e.id}>
                      <button type="button" className="sp-conn-tile" aria-label={t('connectors.tile.connect', { name: e.name })} onClick={() => onConnect(e)}>
                        <ConnectorLogo name={e.name} site={e.site} category={e.category} />
                        <span className="sp-conn-tile__text">
                          <span className="sp-conn-tile__name">{e.name}</span>
                          <span className="sp-conn-tile__desc" title={e.description}>
                            {e.description}
                          </span>
                        </span>
                        <Plus className="cx-tile__trail" size={16} aria-hidden />
                      </button>
                    </div>
                  ))}
                </TileGrid>
                <MoreButton hidden={rows.hidden} open={isOpen && !searching && group.entries.length > GROUP_PREVIEW} onToggle={toggle} />
              </section>
            )
          })}
        </div>
      )}
    </>
  )
}

function MoreButton({ hidden, open, onToggle }: { hidden: number; open: boolean; onToggle(): void }): ReactElement | null {
  const t = useT()
  if (hidden === 0 && !open) return null
  return (
    <button type="button" className="cx-more" aria-expanded={open} onClick={onToggle}>
      {open ? t('connectors.page.showLess') : t('connectors.page.showMore', { count: hidden })}
    </button>
  )
}

function ConnectorTile({ connector: c, entries, onOpen }: { connector: Connector; entries: readonly DirectoryEntry[]; onOpen(): void }): ReactElement {
  const t = useT()
  const entry = c.directoryId ? entries.find((e) => e.id === c.directoryId) : undefined
  const attention = needsAttention(c)
  const name = c.accountLabel ? `${c.displayName} · ${c.accountLabel}` : c.displayName
  const sub = attention || !c.enabled || c.health !== 'ok' ? healthText(t, c) : (entry?.description ?? c.url)
  return (
    <button type="button" className={c.enabled ? 'sp-conn-tile' : 'sp-conn-tile cx-tile--off'} aria-label={`${t('connectors.tile.open', { name })}. ${healthText(t, c)}`} onClick={onOpen}>
      <span className="cx-tile__logo">
        <ConnectorLogo name={c.displayName} logo={c.logo} site={entry?.site ?? null} category={entry?.category ?? null} local={c.transport.kind === 'local'} />
        {c.labelColor && <span className="cx-label-dot cx-label-dot--tile" style={{ background: c.labelColor }} aria-hidden />}
      </span>
      <span className="sp-conn-tile__text">
        <span className="sp-conn-tile__name">{name}</span>
        <span className={attention ? 'sp-conn-tile__desc cx-tile__alert' : 'sp-conn-tile__desc'}>{sub}</span>
      </span>
      {attention && <StatusDot status={healthDot(c)} size={7} label="" pulse={false} />}
      <ChevronRight className="cx-tile__trail" size={16} aria-hidden />
    </button>
  )
}
