/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier://packs (docs/packs.md): your packs as cards that say what each one is
// (an app, a game, a world, skills, a look, a companion, tools), filtered by
// type and opened in a sheet with what it brings and what it may do; the
// packs a companion is still building, above them; and Browse, the community
// indexes you added. Add installs from a file, a link or a folder, and New
// pack has a companion build one. Every install opens the review sheet first.
// The address can say what to show: ?pack=<id>, ?draft=<id>&review=1,
// ?tab=browse or ?install=<https url>.
import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { ChevronDown, Globe, MoreHorizontal, Package, Plus, RefreshCw, Trash2, Wand2 } from 'lucide-react'
import { DEFAULT_PACK_INDEXES, type PackDraftSummary, type PackIndexEntry, type PackReview, type PackSummary, type PacksState } from '@shared/packs'
import { internalQuery } from '@shared/url'
import { call, errorText } from '../api'
import { t } from '../i18n/useT'
import { KindIcon } from '../packs/KindIcon'
import { PackDetail } from '../packs/PackDetail'
import { ReviewSheet } from '../packs/ReviewSheet'
import { cardOpens, cardStatus, filterBrowse, filterPacks, kindCounts, packKind, sortDrafts, sortPacks, type PackKind } from '../packs/logic'
import { BrowseCard } from '../packs/BrowseCard'
import { DestinationEmpty, DestinationFrame } from '../settings/destinations/common'
import { DestinationToolbar, FilterChip, Notice, PageHeader, TextArea, TextInput } from '../settings/kit'
import { useEvent, useResource } from '../settings/data'
import { Badge, Button, Dialog, ErrorState, IconButton, RelativeTime, Sheet, SkeletonRows, Switch, cx, showMenu, useConfirm, useToast } from '../ui'
import '../packs/packs.css'

type View = 'yours' | 'browse'
type BrowseKind = 'all' | 'app' | 'world' | 'pack'

export interface PacksPageProps {
  tabId: string
  url: string
}

/** "Game · Comes with Atelier", "App · By Senne": what a pack is and who made it. */
export function packByline(p: PackSummary): string {
  const by = p.source.kind === 'first-party' ? t('packs.badge.firstParty') : p.author ? t('packs.browse.by', { author: p.author }) : p.builtBy ? t('packs.drafts.builtBy', { name: p.builtBy }) : null
  return [t(`packs.kind.one.${packKind(p)}`), by].filter(Boolean).join(' · ')
}

export function PacksPage({ url }: PacksPageProps): ReactElement {
  const toast = useToast()
  const state = useResource<PacksState>(() => call('packs', 'state'))
  useEvent('packs', (event) => state.set(event.state))
  const queryTab = internalQuery(url, 'tab')
  const queryPack = internalQuery(url, 'pack')
  const queryDraft = internalQuery(url, 'draft')
  const queryReview = internalQuery(url, 'review') === '1'
  const queryInstall = internalQuery(url, 'install')
  const queryOpened = internalQuery(url, 'opened')
  const queryKey = internalQuery(url, 'key')
  const queryFind = internalQuery(url, 'find')
  const queryOpen = internalQuery(url, 'open')
  const [view, setView] = useState<View>(queryTab === 'browse' && !queryPack && !queryDraft ? 'browse' : 'yours')
  const [open, setOpen] = useState<string | null>(queryPack)
  const [review, setReview] = useState<PackReview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [kind, setKind] = useState<PackKind | 'all'>('all')
  const [search, setSearch] = useState('')
  const [browseSearch, setBrowseSearch] = useState(queryFind ?? '')
  const [browseKind, setBrowseKind] = useState<BrowseKind>('all')
  const [linkOpen, setLinkOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [building, setBuilding] = useState(false)
  const handled = useRef<string | null>(null)

  const run = async (what: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(what)
    try {
      await action()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  // What the address asks for, once per address.
  useEffect(() => {
    if (handled.current === url) return
    handled.current = url
    if (queryFind) setBrowseSearch(queryFind)
    if (queryPack) {
      setView('yours')
      setOpen(queryPack)
      // A notification from one of its apps: the app itself.
      if (queryOpen) void run(`open:${queryPack}`, () => call('packs', 'openApp', queryPack, queryOpen))
    } else if (queryDraft) {
      setView('yours')
      if (queryReview) void run(`review:${queryDraft}`, async () => setReview(await call('packs', 'reviewDraft', queryDraft)))
    } else if (queryOpened) {
      void run('opened', async () => setReview(await call('packs', 'openedReview', queryOpened)))
    } else if (queryInstall) {
      void run('link', async () => setReview(await call('packs', 'reviewLink', queryInstall)))
    } else if (queryTab === 'browse') setView('browse')
    else if (queryTab === 'drafts') setView('yours')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // An organisation's policy (docs/apps.md › Apps for organisations); without one everything shows as always.
  const policy = state.data?.policy ?? { managed: false, sideloading: true, indexesLocked: false, audit: false, aiProvider: false }
  const packs = sortPacks(state.data?.packs ?? [])
  const drafts = sortDrafts(state.data?.drafts ?? [])
  const kinds = kindCounts(packs)
  // A filter whose last pack went away shows everything again.
  const activeKind = kind !== 'all' && kinds.some((k) => k.kind === kind) ? kind : 'all'
  const shown = filterPacks(packs, activeKind, search)
  const filtering = activeKind !== 'all' || search.trim() !== ''
  const openPack = open ? (packs.find((p) => p.id === open) ?? null) : null

  const addMenu = async (anchor: HTMLElement): Promise<void> => {
    const choice = await showMenu(
      [
        { id: 'file', label: t('packs.add.file') },
        { id: 'link', label: t('packs.add.link') },
        { id: 'sep', label: '', type: 'separator' },
        { id: 'folder', label: t('packs.add.folder') },
      ],
      anchor,
    )
    if (choice === 'file') await run('file', async () => setReview(await call('packs', 'reviewFile')))
    else if (choice === 'link') setLinkOpen(true)
    else if (choice === 'folder') await run('folder', async () => setReview(await call('packs', 'loadFolder')))
  }

  const openThing = (p: PackSummary): void => {
    const target = cardOpens(p)
    if (!target) return setOpen(p.id)
    void run(`open:${p.id}`, () => ('app' in target ? call('packs', 'openApp', p.id, target.app) : call('packs', 'openWorld', target.world)))
  }

  return (
    <DestinationFrame label={t('packs.page.title')}>
      <PageHeader
        title={t('packs.page.title')}
        description={t('packs.page.lede')}
        actions={
          <>
            {policy.sideloading && (
              <Button variant="secondary" icon={<Plus />} aria-haspopup="menu" loading={busy === 'file' || busy === 'folder'} onClick={(e) => void addMenu(e.currentTarget)}>
                {t('packs.page.add')}
                <ChevronDown className="pk-add__chevron" aria-hidden />
              </Button>
            )}
            <Button variant="primary" icon={<Wand2 />} onClick={() => setBuilding(true)}>
              {t('packs.page.new')}
            </Button>
          </>
        }
      />

      {policy.managed && (
        <Notice tone="info">
          {policy.sideloading ? t('packs.policy.managed') : t('packs.policy.noSideloading')}
          {policy.aiProvider ? ` ${t('packs.policy.aiProvider')}` : ''}
        </Notice>
      )}

      <DestinationToolbar<View>
        segments={{
          label: t('packs.page.sections'),
          value: view,
          options: [
            { value: 'yours', label: <>{t('packs.view.yours')}{state.data && <span className="pk-count">{packs.length}</span>}</> },
            { value: 'browse', label: t('packs.tab.browse') },
          ],
          onChange: setView,
        }}
        search={view === 'yours' ? { value: search, onChange: setSearch, placeholder: t('packs.view.search') } : { value: browseSearch, onChange: setBrowseSearch, placeholder: t('packs.browse.searchPlaceholder') }}
      >
        {view === 'browse' && !policy.indexesLocked && (state.data?.indexes.length ?? 0) > 0 && (
          <Button variant="ghost" icon={<Globe />} onClick={() => setSourcesOpen(true)}>
            {t('packs.sources.button')}
          </Button>
        )}
      </DestinationToolbar>

      {state.error && !state.data ? (
        <ErrorState title={t('packs.page.loadError')} message={state.error} onRetry={state.reload} />
      ) : !state.data ? (
        <SkeletonRows rows={4} label={t('packs.page.loading')} />
      ) : view === 'yours' ? (
        <div className="pk-view">
          {kinds.length > 1 && (
            <div className="pk-chips" role="group" aria-label={t('packs.kind.filter')}>
              <FilterChip label={<>{t('packs.kind.all')}<span className="pk-count">{packs.length}</span></>} pressed={activeKind === 'all'} onClick={() => setKind('all')} />
              {kinds.map((k) => (
                <FilterChip
                  key={k.kind}
                  label={
                    <>
                      {t(`packs.kind.many.${k.kind}`)}
                      <span className="pk-count">{k.count}</span>
                    </>
                  }
                  pressed={activeKind === k.kind}
                  onClick={() => setKind(k.kind)}
                />
              ))}
            </div>
          )}

          {drafts.length > 0 && !filtering && (
            <section className="pk-section" aria-labelledby="pk-drafts-title">
              <h2 className="pk-section__title" id="pk-drafts-title">
                {t('packs.drafts.title')}
              </h2>
              <ul className="pk-drafts">
                {drafts.map((d) => (
                  <DraftRow key={d.id} draft={d} busy={busy} run={run} onReview={setReview} />
                ))}
              </ul>
              {state.data.authorKey && <p className="pk-foot">{t('packs.page.authorKey', { key: state.data.authorKey })}</p>}
            </section>
          )}

          {packs.length === 0 ? (
            drafts.length === 0 && (
              <DestinationEmpty
                icon={<Package />}
                title={t('packs.installed.empty.title')}
                description={t('packs.empty.body')}
                primary={
                  <Button variant="primary" icon={<Globe />} onClick={() => setView('browse')}>
                    {t('packs.empty.browse')}
                  </Button>
                }
                secondary={
                  <Button variant="secondary" icon={<Wand2 />} onClick={() => setBuilding(true)}>
                    {t('packs.page.new')}
                  </Button>
                }
              />
            )
          ) : shown.length === 0 ? (
            <DestinationEmpty
              icon={<Package />}
              title={t('packs.view.noMatch')}
              primary={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('')
                    setKind('all')
                  }}
                >
                  {t('packs.view.clear')}
                </Button>
              }
            />
          ) : (
            <section className="pk-section" aria-labelledby={drafts.length > 0 && !filtering ? 'pk-installed-title' : undefined} aria-label={drafts.length > 0 && !filtering ? undefined : t('packs.view.yours')}>
              {drafts.length > 0 && !filtering && (
                <h2 className="pk-section__title" id="pk-installed-title">
                  {t('packs.tab.installed')}
                </h2>
              )}
              <ul className="pk-grid" aria-label={t('packs.view.yours')}>
                {shown.map((p) => (
                  <PackCard
                    key={p.id}
                    pack={p}
                    busy={busy === `open:${p.id}`}
                    onDetails={() => setOpen(p.id)}
                    onOpen={() => openThing(p)}
                    onToggle={(enabled) => void run(`toggle:${p.id}`, () => call('packs', 'setEnabled', p.id, enabled))}
                  />
                ))}
              </ul>
            </section>
          )}

          {packs.length > 0 && (
            <div className="pk-foot-row">
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw />}
                loading={busy === 'updates'}
                onClick={() =>
                  void run('updates', async () => {
                    await call('packs', 'checkUpdates')
                    toast.show({ message: t('packs.detail.checked') })
                  })
                }
              >
                {t('packs.page.checkUpdates')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <BrowsePanel state={state.data} onReview={setReview} find={queryFind} search={browseSearch} kind={browseKind} onKind={setBrowseKind} onSources={() => setSourcesOpen(true)} />
      )}

      <Sheet open={openPack !== null} onClose={() => setOpen(null)} title={openPack?.name ?? ''} description={openPack ? packByline(openPack) : undefined} size="lg" className="pk-sheet">
        {openPack && <PackDetail pack={openPack} onReview={setReview} focusKey={queryPack === openPack.id ? queryKey : null} audited={policy.audit} />}
      </Sheet>
      <ReviewSheet
        review={review}
        onClose={() => setReview(null)}
        onInstalled={(pack) => {
          setView('yours')
          setOpen(pack.id)
        }}
      />
      <NewPackDialog open={building} onClose={() => setBuilding(false)} />
      {policy.sideloading && <LinkDialog open={linkOpen} onClose={() => setLinkOpen(false)} onReview={setReview} />}
      {!policy.indexesLocked && <SourcesDialog open={sourcesOpen} onClose={() => setSourcesOpen(false)} state={state.data ?? null} />}
    </DestinationFrame>
  )
}

/** One installed pack: its type, name and line, what needs you, Open and on or off. The rest opens in its sheet. */
function PackCard({ pack, busy, onDetails, onOpen, onToggle }: { pack: PackSummary; busy: boolean; onDetails(): void; onOpen(): void; onToggle(enabled: boolean): void }): ReactElement {
  const kind = packKind(pack)
  const status = cardStatus(pack)
  const opens = cardOpens(pack)
  // Open works on a pack that is off (it turns on); only one that can't run says no.
  const openable = pack.problems.length === 0 && !(pack.enabled && pack.waiting.length > 0)
  return (
    <li className={cx('pk-tile', !pack.enabled && 'pk-tile--off')} data-kind={kind}>
      <button type="button" className="pk-tile__main" onClick={onDetails} aria-label={t('packs.tile.details', { name: pack.name })}>
        <span className="pk-tile__head">
          <KindIcon kind={kind} />
          <span className="pk-tile__titles">
            <span className="pk-tile__name">{pack.name}</span>
            <span className="pk-tile__line">{packByline(pack)}</span>
          </span>
        </span>
        <span className="pk-tile__desc">{pack.description}</span>
      </button>
      <div className="pk-tile__foot">
        {status ? <Badge tone={status.tone}>{t(status.key, status.vars)}</Badge> : <span />}
        <span className="pk-tile__actions">
          {opens && (
            <Button size="sm" variant="secondary" disabled={!openable} loading={busy} onClick={onOpen}>
              {t('packs.row.open')}
            </Button>
          )}
          <Switch size="sm" aria-label={t('packs.row.toggle', { name: pack.name })} checked={pack.enabled} disabled={(pack.problems.length > 0 && !pack.enabled) || (pack.managed && pack.enabled)} onChange={onToggle} />
        </span>
      </div>
    </li>
  )
}

/** A pack being built: whether it's ready, who built it and when, Review and install, and the rest in a menu. */
function DraftRow({ draft: d, busy, run, onReview }: { draft: PackDraftSummary; busy: string | null; run(what: string, action: () => Promise<unknown>): Promise<void>; onReview(review: PackReview): void }): ReactElement {
  const toast = useToast()
  const confirm = useConfirm()
  const broken = d.problems.length > 0
  const more = async (anchor: HTMLElement): Promise<void> => {
    const choice = await showMenu(
      [
        { id: 'edit', label: t('packs.drafts.edit') },
        { id: 'export', label: t('packs.detail.export'), enabled: !broken },
        { id: 'reveal', label: t('packs.drafts.reveal') },
        { id: 'sep', label: '', type: 'separator' },
        { id: 'delete', label: t('packs.drafts.delete'), danger: true },
      ],
      anchor,
    )
    if (choice === 'edit') await run(`edit:${d.id}`, () => call('packs', 'editDraft', d.id))
    else if (choice === 'export') await run(`export:${d.id}`, async () => (await call('packs', 'exportPack', d.id, 'draft')) && toast.show({ message: t('packs.exported') }))
    else if (choice === 'reveal') await run(`reveal:${d.id}`, () => call('packs', 'revealDraft', d.id))
    else if (choice === 'delete' && (await confirm({ title: t('packs.drafts.deleteTitle', { name: d.name }), message: t('packs.drafts.deleteMessage'), destructive: true }))) await run(`delete:${d.id}`, () => call('packs', 'removeDraft', d.id))
  }
  return (
    <li className="pk-draft">
      <span className="pk-draft__icon" aria-hidden="true">
        <Wand2 />
      </span>
      <span className="pk-draft__text">
        <span className="pk-draft__name">
          {d.name}
          {broken ? (
            <Badge tone="danger">{t('packs.drafts.problems', { count: d.problems.length })}</Badge>
          ) : d.installedSame ? (
            <Badge tone="success">{t('packs.drafts.installed')}</Badge>
          ) : (
            <Badge tone="success">{t('packs.drafts.ready')}</Badge>
          )}
          {d.installedVersion && !d.installedSame && <Badge tone="info">{t('packs.drafts.replaces', { version: d.installedVersion })}</Badge>}
        </span>
        <span className="pk-draft__line">
          {d.builtBy ? `${t('packs.drafts.builtBy', { name: d.builtBy })} · ` : ''}
          <RelativeTime value={d.updatedAt} />
        </span>
        {broken && (
          <details className="pk-draft__problems">
            <summary>{t('packs.drafts.showProblems')}</summary>
            <ul>
              {d.problems.slice(0, 8).map((p) => (
                <li key={p} className="pk-mono">
                  {p}
                </li>
              ))}
            </ul>
          </details>
        )}
      </span>
      <span className="pk-draft__actions">
        {broken ? (
          <Button size="sm" variant="secondary" icon={<Wand2 />} loading={busy === `edit:${d.id}`} onClick={() => void run(`edit:${d.id}`, () => call('packs', 'editDraft', d.id))}>
            {t('packs.drafts.fix')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" loading={busy === `review:${d.id}`} onClick={() => void run(`review:${d.id}`, async () => onReview(await call('packs', 'reviewDraft', d.id)))}>
            {t('packs.drafts.review')}
          </Button>
        )}
        <IconButton size="sm" label={t('packs.drafts.more', { name: d.name })} icon={<MoreHorizontal />} aria-haspopup="menu" onClick={(e) => void more(e.currentTarget)} />
      </span>
    </li>
  )
}

function NewPackDialog({ open, onClose }: { open: boolean; onClose(): void }): ReactElement {
  const id = useId()
  const toast = useToast()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      await call('packs', 'startBuild', text.trim())
      setText('')
      onClose()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('packs.new.title')}
      description={t('packs.new.description')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('packs.review.cancel')}
          </Button>
          <Button variant="primary" icon={<Wand2 />} loading={busy} disabled={!text.trim()} onClick={() => void start()}>
            {t('packs.new.build')}
          </Button>
        </>
      }
    >
      <label className="pk-block__title" htmlFor={`${id}-what`}>
        {t('packs.new.label')}
      </label>
      <TextArea id={`${id}-what`} rows={5} value={text} placeholder={t('packs.new.placeholder')} onChange={(e) => setText(e.target.value)} />
    </Dialog>
  )
}

/** Add › From a link…: the address of a shared file, then its review. */
function LinkDialog({ open, onClose, onReview }: { open: boolean; onClose(): void; onReview(review: PackReview): void }): ReactElement {
  const id = useId()
  const [link, setLink] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    const target = link.trim()
    if (!target) return
    setError(null)
    setBusy(true)
    try {
      onReview(await call('packs', 'reviewLink', target))
      setLink('')
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('packs.link.label')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('packs.review.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!link.trim()} onClick={() => void submit()}>
            {t('packs.link.button')}
          </Button>
        </>
      }
    >
      <form className="pk-dialog-form" onSubmit={(e) => void submit(e)}>
        <TextInput
          id={`${id}-link`}
          value={link}
          placeholder="https://"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          aria-label={t('packs.link.label')}
          invalid={Boolean(error)}
          aria-describedby={`${id}-link-hint`}
          onChange={(e) => {
            setLink(e.target.value)
            setError(null)
          }}
        />
        <p className={cx('pk-small', error ? 'pk-error' : 'pk-muted')} id={`${id}-link-hint`} role={error ? 'alert' : undefined}>
          {error ?? t('packs.link.hint')}
        </p>
      </form>
    </Dialog>
  )
}

/** Browse › Sources: the community indexes you added, and a field to add one. */
function SourcesDialog({ open, onClose, state }: { open: boolean; onClose(): void; state: PacksState | null }): ReactElement {
  const id = useId()
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const add = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (!address.trim()) return
    setError(null)
    setBusy(true)
    try {
      await call('packs', 'addIndex', address.trim())
      setAddress('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const indexes = state?.indexes ?? []
  return (
    <Dialog open={open} onClose={onClose} title={t('packs.sources.title')} description={t('packs.sources.description')} footer={<Button variant="secondary" onClick={onClose}>{t('packs.sources.done')}</Button>}>
      {indexes.length > 0 && (
        <ul className="pk-things" aria-label={t('packs.browse.indexes')}>
          {indexes.map((index) => (
            <li key={index.url} className="pk-thing">
              <span className="pk-thing__text">
                {index.name ?? index.url}
                <span className="pk-thing__kind">{index.lastError ? t('packs.browse.indexError', { error: index.lastError }) : index.url}</span>
              </span>
              <IconButton size="sm" icon={<Trash2 />} label={t('packs.browse.remove', { name: index.name ?? index.url })} onClick={() => void call('packs', 'removeIndex', index.url)} />
            </li>
          ))}
        </ul>
      )}
      <form className="pk-dialog-form" onSubmit={(e) => void add(e)}>
        <label className="pk-block__title" htmlFor={`${id}-index`}>
          {t('packs.browse.addLabel')}
        </label>
        <div className="pk-row-form">
          <TextInput id={`${id}-index`} className="pk-row-form__input" value={address} placeholder="https://" spellCheck={false} inputMode="url" invalid={Boolean(error)} aria-describedby={`${id}-index-hint`} onChange={(e) => setAddress(e.target.value)} />
          <Button type="submit" variant="secondary" loading={busy} disabled={!address.trim()}>
            {t('packs.browse.add')}
          </Button>
        </div>
        <p className={cx('pk-small', error ? 'pk-error' : 'pk-muted')} id={`${id}-index-hint`} role={error ? 'alert' : undefined}>
          {error ?? t('packs.browse.hint')}
        </p>
      </form>
    </Dialog>
  )
}

function BrowsePanel({ state, onReview, find, search, kind, onKind, onSources }: { state: PacksState; onReview(review: PackReview): void; find?: string | null; search: string; kind: BrowseKind; onKind(kind: BrowseKind): void; onSources(): void }): ReactElement {
  const toast = useToast()
  const [entries, setEntries] = useState<PackIndexEntry[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    setBusy('load')
    try {
      setEntries(await call('packs', 'browse'))
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }
  // Read again whenever the indexes change (Sources adds or removes one).
  const indexKey = state.indexes.map((i) => i.url).join(' ')
  useEffect(() => {
    if (state.indexes.length > 0) void load()
    else setEntries(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexKey])

  // What Open on a card does for a pack that is here: its first app, else its first world.
  const openerFor = (id: string): (() => void) | undefined => {
    const p = state.packs.find((x) => x.id === id)
    const fail = (err: unknown): void => {
      toast.show({ tone: 'error', message: errorText(err) })
    }
    if (p?.apps[0]) return () => void call('packs', 'openApp', p.id, p.apps[0]!.id).catch(fail)
    if (p?.worlds[0]) return () => void call('packs', 'openWorld', p.worlds[0]!.ref).catch(fail)
    return undefined
  }

  // A private index (the organisation's): sign in, then read it.
  const signIn = async (url: string): Promise<void> => {
    setBusy(`signin:${url}`)
    try {
      await call('packs', 'signInIndex', url)
      await load()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  const addCommunity = async (): Promise<void> => {
    setBusy('add')
    try {
      await call('packs', 'addIndex', (DEFAULT_PACK_INDEXES[0] as { url: string }).url)
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  const matches = entries ? filterBrowse(entries, kind, search) : []
  return (
    <div className="pk-view">
      {state.policy.indexesLocked && <p className="pk-muted pk-small">{t('packs.policy.indexesLocked')}</p>}
      {state.indexes.map((index) =>
        index.signIn && !index.signIn.signedIn ? (
          <Notice
            key={index.url}
            tone="info"
            action={
              <Button size="sm" variant="primary" loading={busy === `signin:${index.url}`} onClick={() => void signIn(index.url)}>
                {t('packs.signIns.signIn')}
              </Button>
            }
          >
            {t('packs.browse.signInNeeded', { name: index.name ?? index.url, issuer: index.signIn.issuer })}
          </Notice>
        ) : null,
      )}
      {find && (state.indexes.length === 0 || (entries !== null && !entries.some((e) => e.id === find) && filterBrowse(entries, 'all', find).length === 0)) && (
        <Notice tone="info">{t('packs.browse.notListed', { id: find })}</Notice>
      )}
      {state.indexes.length === 0 ? (
        <DestinationEmpty
          icon={<Globe />}
          title={t('packs.browse.empty.title')}
          description={t('packs.browse.empty.body')}
          primary={
            !state.policy.indexesLocked && DEFAULT_PACK_INDEXES[0] ? (
              <Button variant="primary" loading={busy === 'add'} onClick={() => void addCommunity()}>
                {t('packs.browse.addCommunity')}
              </Button>
            ) : undefined
          }
          secondary={
            !state.policy.indexesLocked ? (
              <Button variant="secondary" onClick={onSources}>
                {t('packs.sources.addOther')}
              </Button>
            ) : undefined
          }
        />
      ) : entries === null ? (
        <SkeletonRows rows={3} label={t('packs.page.loading')} />
      ) : entries.length === 0 && state.indexes.every((i) => i.lastError) ? (
        <ErrorState title={t('packs.browse.offline')} message={state.indexes[0]?.lastError ?? ''} onRetry={() => load()} />
      ) : entries.length === 0 ? (
        <p className="pk-muted">{t('packs.browse.none')}</p>
      ) : (
        <>
          <div className="pk-chips" role="group" aria-label={t('packs.browse.kindFilter')}>
            {(['all', 'app', 'world', 'pack'] as const).map((k) => (
              <FilterChip key={k} label={t(`packs.browse.kind.${k}`)} pressed={kind === k} onClick={() => onKind(k)} />
            ))}
          </div>
          {matches.length === 0 ? (
            <p className="pk-muted">{t('packs.browse.noMatch')}</p>
          ) : (
            <ul className="pk-browse" aria-label={t('packs.tab.browse')}>
              {matches.map((e) => (
                <BrowseCard
                  key={`${e.indexUrl}:${e.id}`}
                  entry={e}
                  busy={busy === `install:${e.id}`}
                  onOpen={openerFor(e.id)}
                  onInstall={() =>
                    void (async () => {
                      setBusy(`install:${e.id}`)
                      try {
                        onReview(await call('packs', 'reviewIndexEntry', e.indexUrl, e.id))
                      } catch (err) {
                        toast.show({ tone: 'error', message: errorText(err) })
                      } finally {
                        setBusy(null)
                      }
                    })()
                  }
                />
              ))}
            </ul>
          )}
          <div className="pk-foot-row">
            <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={busy === 'load'} onClick={() => void load()}>
              {t('packs.browse.refresh')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
