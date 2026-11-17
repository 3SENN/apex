/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Apps section of atelier://workspace,
// lazily imported by sections.ts: websites saved as apps, apps from
// packs, and every app your companions built, as tiles in groups that show
// only when they hold something; a detail view with the still, versions and
// restore; open in a sandboxed tab, export the HTML, delete to Recently
// Deleted; New app, and Get more apps (Packs › Discover).
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { AppWindow, ArrowLeft, ChevronRight, Download, Plus, RotateCcw, Store, Trash2 } from 'lucide-react'
import { SHARED_OWNER } from '@shared/chats'
import type { AppSummary, AppVersion } from '@shared/apps'
import { call, errorText, formatBytes } from '../../../api'
import { AppGlyph } from '../../../apps/AppGlyph'
import { AppStill } from '../../../apps/AppPreviewCard'
import { NewAppSheet } from '../../../apps/NewAppSheet'
import { t } from '../../../i18n/useT'
import { useCompanions, useEvent, useLiveResource, useResource } from '../../../settings/data'
import { Badge, Button, EmptyState, ErrorState, IconButton, RelativeTime, SkeletonRows, showContextMenu, useConfirm, useToast } from '../../../ui'
import { SearchBox, SectionHead } from '../../../workspace/kit'
import { goWorkspace } from '../../../workspace/open'
import '../../../workspace/workspace.css'
import '../../../apps/platform.css'
import { shareAsPack } from '../../../packs/share'
import { WebAppsBlock } from './WebApps'
import { PackAppsBlock, SidebarMark, browsePacks } from './PackApps'
import { builtAppRef, showOf } from '@shared/sidebarApps'
import { chosenShow, setAppShow, sidebarMenuItems } from '../../../apps/library'
import { useSettingsView } from '../../../companion-card/useLoaded'

export interface AppsSectionProps {
  /** atelier://workspace/apps/<id> opens that app's detail. */
  itemId?: string | null
}

type AppDetail = AppSummary & { versions: AppVersion[] }

export function companionLabel(id: string, companions: ReadonlyArray<{ id: string; name: string }> | null): string {
  if (id === SHARED_OWNER) return t('platform.common.shared')
  return companions?.find((c) => c.id === id)?.name ?? t('platform.common.aCompanion')
}

export default function AppsSection({ itemId = null }: AppsSectionProps): ReactElement {
  const apps = useLiveResource(() => call('apps', 'list'), 'apps', (e) => e.items)
  const companions = useCompanions()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(itemId)
  const [creating, setCreating] = useState(false)
  const [webCount, setWebCount] = useState(0)
  const [packCount, setPackCount] = useState(0)
  // Whether the websites and packs groups have nothing to show (null until they know).
  const [webEmpty, setWebEmpty] = useState<boolean | null>(null)
  const [packEmpty, setPackEmpty] = useState<boolean | null>(null)
  const pins = useSettingsView()?.sidebar.apps ?? []
  const confirm = useConfirm()
  const toast = useToast()

  useEffect(() => setSelected(itemId), [itemId])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (apps.data ?? []).filter((a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
  }, [apps.data, query])

  const failed = (err: unknown): void => {
    toast.show({ tone: 'error', message: errorText(err) })
  }
  const open = (app: AppSummary, versionId?: string): void => {
    Promise.resolve(call('apps', 'open', app.id, versionId)).catch(failed)
  }
  const exportHtml = async (app: AppSummary): Promise<void> => {
    try {
      const path = await call('apps', 'exportHtml', app.id)
      if (path) toast.show({ tone: 'success', message: t('platform.apps.exported', { name: app.name }) })
    } catch (err) {
      failed(err)
    }
  }
  const remove = async (app: AppSummary): Promise<void> => {
    const ok = await confirm({ title: t('platform.apps.delete.title', { name: app.name }), message: t('platform.apps.delete.message'), confirmLabel: t('platform.apps.delete.confirm'), destructive: true })
    if (!ok) return
    try {
      await call('apps', 'remove', app.id)
      if (selected === app.id) setSelected(null)
      toast.show({ message: t('platform.apps.deleted', { name: app.name }), action: { label: t('platform.common.recentlyDeleted'), onAction: () => goWorkspace('trash') } })
    } catch (err) {
      failed(err)
    }
  }
  const menu = (app: AppSummary) => (e: { clientX: number; clientY: number; currentTarget: EventTarget | null; preventDefault(): void }) =>
    void showContextMenu(e, [
      { id: 'open', label: t('platform.apps.open'), enabled: Boolean(app.currentVersionId ?? app.draftVersionId) },
      { id: 'sep-sidebar', label: '', type: 'separator' },
      ...sidebarMenuItems(showOf({ ref: builtAppRef(app.id), defaultShow: 'hidden' }, pins)),
      { id: 'sep-more', label: '', type: 'separator' },
      { id: 'details', label: t('platform.apps.details') },
      { id: 'export', label: t('platform.apps.export'), enabled: Boolean(app.currentVersionId ?? app.draftVersionId) },
      { id: 'share-pack', label: t('packs.share.action'), enabled: Boolean(app.currentVersionId ?? app.draftVersionId) },
      { id: 'delete', label: t('platform.apps.delete.menu'), danger: true },
    ]).then((id) => {
      const show = chosenShow(id)
      if (show) setAppShow(pins, builtAppRef(app.id), show)
      else if (id === 'open') open(app)
      else if (id === 'details') setSelected(app.id)
      else if (id === 'export') void exportHtml(app)
      else if (id === 'share-pack') void shareAsPack('app', app.id)
      else if (id === 'delete') void remove(app)
    })

  const newButton = (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      {t('platform.apps.new.button')}
    </Button>
  )
  const actions = (
    <>
      <Button variant="ghost" icon={<Store />} onClick={browsePacks}>
        {t('platform.library.getMore')}
      </Button>
      {newButton}
    </>
  )
  const total = apps.data?.length ?? 0
  const allEmpty = apps.data !== null && total === 0 && webEmpty === true && packEmpty === true

  return (
    <section className="ws-card" aria-label={t('platform.apps.title')}>
      {selected ? (
        <AppDetailView
          appId={selected}
          companions={companions.items}
          onBack={() => setSelected(null)}
          onOpen={open}
          onExport={(app) => void exportHtml(app)}
          onDelete={(app) => void remove(app)}
        />
      ) : (
        <>
          <SectionHead title={t('platform.apps.title')} subtitle={allEmpty ? undefined : apps.data ? t('platform.apps.count', { count: total + webCount + packCount }) : t('platform.apps.subtitle')} actions={actions} />
          <div className="ws-card__body">
            {/* AP-01: every app in one place: websites saved as apps, apps from packs, then the apps your companions made. */}
            {allEmpty && <EmptyState compact icon={<AppWindow />} title={t('platform.apps.count', { count: 0 })} description={t('platform.library.emptyAll')} />}
            <WebAppsBlock pins={pins} onCount={setWebCount} onEmpty={setWebEmpty} />
            <PackAppsBlock pins={pins} onCount={setPackCount} onEmpty={setPackEmpty} />
            {total > 0 && <h3 className="wa__title">{t('platform.webApps.built')}</h3>}
            {total > 5 && (
              <div className="pl-toolbar">
                <SearchBox value={query} onChange={setQuery} placeholder={t('platform.apps.search')} />
              </div>
            )}
            {apps.error && !apps.data ? (
              <ErrorState title={t('platform.apps.loadError')} message={apps.error} onRetry={apps.reload} />
            ) : !apps.data ? (
              <SkeletonRows rows={4} avatar label={t('platform.apps.loading')} />
            ) : total === 0 ? null : shown.length === 0 ? (
              <EmptyState compact title={t('platform.common.noMatch', { query })} action={<Button onClick={() => setQuery('')}>{t('platform.common.clearSearch')}</Button>} />
            ) : (
              <div className="pl-grid" role="list" aria-label={t('platform.apps.title')}>
                {shown.map((app) => (
                  <div role="listitem" key={app.id}>
                    <button type="button" className="pl-tile" onClick={() => setSelected(app.id)} onContextMenu={menu(app)} aria-label={t('platform.apps.tileLabel', { name: app.name })}>
                      <AppGlyph id={app.id} name={app.name} />
                      <span className="pl-tile__text">
                        <span className="pl-tile__name">
                          <span>{app.name}</span>
                          {!app.currentVersionId && <Badge tone="warning">{t('platform.apps.label.draft')}</Badge>}
                        </span>
                        <span className="pl-tile__desc">{app.description || t('platform.apps.madeBy', { companion: companionLabel(app.createdBy, companions.items) })}</span>
                      </span>
                      <SidebarMark show={showOf({ ref: builtAppRef(app.id), defaultShow: 'hidden' }, pins)} />
                      <ChevronRight className="pl-tile__chev" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      <NewAppSheet
        open={creating}
        onClose={(chatId) => {
          setCreating(false)
          if (chatId) toast.show({ message: t('platform.apps.new.started') })
        }}
      />
    </section>
  )
}

function AppDetailView({
  appId,
  companions,
  onBack,
  onOpen,
  onExport,
  onDelete,
}: {
  appId: string
  companions: ReadonlyArray<{ id: string; name: string }> | null
  onBack(): void
  onOpen(app: AppSummary, versionId?: string): void
  onExport(app: AppSummary): void
  onDelete(app: AppSummary): void
}): ReactElement {
  const app = useResource<AppDetail>(() => call('apps', 'get', appId), appId, { keep: true })
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  useEvent('apps', (e) => {
    if (e.items.some((a) => a.id === appId)) void app.reload()
    else onBack()
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const back = (
    <IconButton label={t('platform.apps.back')} icon={<ArrowLeft />} onClick={onBack} />
  )
  if (app.error && !app.data) {
    return (
      <>
        <SectionHead lead={back} title={t('platform.apps.title')} />
        <div className="ws-card__body">
          <ErrorState title={t('platform.apps.card.goneTitle')} message={app.error} onRetry={app.reload} />
        </div>
      </>
    )
  }
  if (!app.data) {
    return (
      <>
        <SectionHead lead={back} title={t('platform.apps.title')} />
        <div className="ws-card__body">
          <SkeletonRows rows={3} label={t('platform.apps.loading')} />
        </div>
      </>
    )
  }

  const data = app.data
  const runnable = data.currentVersionId ?? data.draftVersionId
  const act = async (key: string, fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(key)
    try {
      await fn()
      toast.show({ tone: 'success', message: done })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }
  const labelOf = (v: AppVersion): string => (v.id === data.draftVersionId ? t('platform.apps.label.draft') : v.label === 'restored' ? t('platform.apps.label.restored') : t('platform.apps.label.saved'))

  return (
    <>
      <SectionHead
        lead={back}
        title={data.name}
        subtitle={t('platform.apps.madeBy', { companion: companionLabel(data.createdBy, companions) })}
        actions={
          <>
            <IconButton label={t('platform.apps.export')} icon={<Download />} disabled={!runnable} onClick={() => onExport(data)} />
            <IconButton label={t('platform.apps.delete.menu')} tone="danger" icon={<Trash2 />} onClick={() => onDelete(data)} />
            <Button variant="primary" icon={<AppWindow />} disabled={!runnable} onClick={() => onOpen(data)}>
              {t('platform.apps.open')}
            </Button>
          </>
        }
      />
      <div className="ws-card__body">
        <div className="pl-detail">
          <div className="pl-detail__head">
            <AppGlyph id={data.id} name={data.name} size="lg" />
            <div className="pl-detail__titles">
              <p className="pl-muted" style={{ margin: 0 }}>
                {data.description || t('platform.apps.noDescription')}
              </p>
              <div className="pl-detail__meta">
                <span>
                  {t('platform.apps.updated')} <RelativeTime value={data.updatedAt} />
                </span>
                <span>{t('platform.apps.versionCount', { count: data.versions.length })}</span>
                {!data.currentVersionId && <Badge tone="warning">{t('platform.apps.notSavedYet')}</Badge>}
              </div>
            </div>
          </div>
          {runnable && <AppStill appId={data.id} versionId={runnable} name={data.name} onOpen={() => onOpen(data)} />}
          <div>
            <h3 className="pl-section-title">{t('platform.apps.versions')}</h3>
            {data.versions.length === 0 ? (
              <p className="pl-faint">{t('platform.apps.noVersions')}</p>
            ) : (
              <ul className="pl-versions">
                {data.versions.map((v) => {
                  const current = v.id === data.currentVersionId
                  const draft = v.id === data.draftVersionId
                  return (
                    <li key={v.id} className="pl-version">
                      <span className="pl-version__main">
                        <Badge tone={draft ? 'warning' : current ? 'success' : 'neutral'}>{current ? t('platform.apps.label.current') : labelOf(v)}</Badge>
                        <RelativeTime value={v.at} />
                        <span className="pl-faint">{formatBytes(v.size)}</span>
                      </span>
                      <span className="pl-row-actions">
                        <Button size="sm" variant="ghost" onClick={() => onOpen(data, v.id)} aria-label={t('platform.apps.openVersion')}>
                          {t('platform.apps.preview')}
                        </Button>
                        {draft ? (
                          <Button size="sm" loading={busy === v.id} onClick={() => void act(v.id, () => call('apps', 'saveDraft', data.id, v.id), t('platform.apps.card.saved', { name: data.name }))}>
                            {t('platform.apps.card.save')}
                          </Button>
                        ) : (
                          !current && (
                            <Button size="sm" icon={<RotateCcw />} loading={busy === v.id} onClick={() => void act(v.id, () => call('apps', 'restoreVersion', data.id, v.id), t('platform.apps.restored'))}>
                              {t('platform.apps.restore')}
                            </Button>
                          )
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          <p className="pl-faint" style={{ margin: 0 }}>
            {t('platform.apps.sandboxNote')}
          </p>
        </div>
      </div>
    </>
  )
}
