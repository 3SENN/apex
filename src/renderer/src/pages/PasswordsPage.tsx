/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier://passwords (ST-05): saved sign-ins behind Touch ID. Locked on
// arrival; unlocking keeps it open for five minutes (main relocks it, also on
// lock-screen and sleep). Unlocked: filter, ?site=<host>, sort, rows with
// reveal and copy, an editor with Generate, delete after confirmation, and
// CSV or Passwords app import.
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Copy, Ellipsis, Eye, EyeOff, KeyRound, LockKeyhole, Pencil, Plus, Trash2, Upload, X } from 'lucide-react'
import { internalQuery } from '@shared/url'
import { siteOfOrigin, type CredentialView, type PasswordsStatus } from '@shared/passwords'
import { atelier, call, errorText } from '../api'
import { DestinationFrame, ListState } from '../settings/destinations/common'
import { useEvent, useResource } from '../settings/data'
import { ListFrame, PageHeader, SearchField } from '../settings/kit'
import { siteInitial } from '../settings/logic/collections'
import { Button, EmptyState, ErrorState, IconButton, Select, SkeletonRows, Spinner, isMac, showMenu, useConfirm, useToast } from '../ui'
import { useT } from '../i18n/useT'
import { CredentialDialog } from '../passwords/CredentialDialog'
import { ImportDialog, type ImportSource } from '../passwords/ImportDialog'
import '../passwords/passwords.css'

/** A revealed password hides itself again after this long. */
const REVEAL_MS = 30_000

type Sort = 'site' | 'recent'

export function PasswordsPage({ tabId, url }: { tabId: string; url: string }): ReactElement {
  const t = useT()
  const site = internalQuery(url, 'site')
  const status = useResource(() => call('passwords', 'status'))
  const [unlocking, setUnlocking] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [importing, setImporting] = useState<ImportSource | null>(null)

  // Lock, unlock and changes made anywhere (autofill, Settings) arrive as one event.
  useEvent('passwords', (e) => {
    if (status.data) status.set({ ...status.data, count: e.count, locked: e.locked })
    else void status.reload()
  })

  const unlock = async (): Promise<void> => {
    if (unlocking) return
    setUnlocking(true)
    setUnlockError(null)
    try {
      const ok = await call('passwords', 'unlock')
      if (!ok) setUnlockError(t('passwords.locked.failed'))
      await status.reload()
    } catch (err) {
      setUnlockError(errorText(err))
    } finally {
      setUnlocking(false)
    }
  }

  const s = status.data
  let body: ReactElement
  if (!s) {
    body = status.error ? <ErrorState message={status.error} onRetry={status.reload} /> : <SkeletonRows rows={4} avatar label={t('passwords.loading')} />
  } else if (!s.available) {
    body = <EmptyState icon={<KeyRound />} title={t('passwords.unavailable.title')} description={t('passwords.unavailable')} action={<Button onClick={() => void status.reload()}>{t('passwords.retry')}</Button>} />
  } else if (s.locked) {
    body = <LockTile unlocking={unlocking} error={unlockError} onUnlock={() => void unlock()} />
  } else {
    body = <UnlockedList status={s} site={site} tabId={tabId} onImport={setImporting} />
  }

  return (
    <DestinationFrame label={t('passwords.page.title')}>
      <PageHeader
        title={t('passwords.page.title')}
        description={t('passwords.page.description')}
        actions={
          s && !s.locked && s.available ? (
            <Button variant="ghost" icon={<LockKeyhole />} onClick={() => void call('passwords', 'lock')}>
              {t('passwords.lock')}
            </Button>
          ) : undefined
        }
      />
      {s && !s.locked && s.available && <p className="pw-header-note">{t('passwords.lock.note')}</p>}
      {body}
      <ImportDialog open={importing !== null} source={importing ?? 'csv'} onClose={() => setImporting(null)} />
    </DestinationFrame>
  )
}

/** The locked and unlocking states: a centred lock tile, a line, and Unlock. */
function LockTile({ unlocking, error, onUnlock }: { unlocking: boolean; error: string | null; onUnlock(): void }): ReactElement {
  const t = useT()
  return (
    <section className="pw-lock" data-state={unlocking ? 'unlocking' : 'locked'} aria-live="polite" aria-busy={unlocking}>
      <span className="pw-lock__tile" aria-hidden>
        <LockKeyhole />
      </span>
      <h2 className="pw-lock__title">{unlocking ? t('passwords.unlocking.title') : t('passwords.locked.title')}</h2>
      <p className="pw-lock__body">{t('passwords.locked.body')}</p>
      {!unlocking && (
        <Button variant="primary" onClick={onUnlock}>
          {t('passwords.locked.unlock')}
        </Button>
      )}
      {unlocking && <Spinner size={16} label={t('passwords.unlocking.title')} />}
      {error && (
        <p className="pw-lock__error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function UnlockedList({ status, site, tabId, onImport }: { status: PasswordsStatus; site: string | null; tabId: string; onImport(source: ImportSource): void }): ReactElement {
  const t = useT()
  const confirm = useConfirm()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<Sort>('site')
  const [editing, setEditing] = useState<CredentialView | 'new' | null>(null)
  const [revealed, setRevealed] = useState<{ id: string; password: string } | null>(null)
  const list = useResource(() => call('passwords', 'list', { ...(site ? { site } : {}), sort }), `${site ?? ''}|${sort}|${status.count}`, { keep: true })
  const items = list.data ?? []
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? items.filter((c) => siteOfOrigin(c.origin).toLowerCase().includes(q) || c.username.toLowerCase().includes(q)) : items
  }, [items, search])

  // A shown password hides again after a while, and when the list changes under it.
  useEffect(() => {
    if (!revealed) return
    const timer = setTimeout(() => setRevealed(null), REVEAL_MS)
    return () => clearTimeout(timer)
  }, [revealed])

  const reveal = async (c: CredentialView): Promise<void> => {
    if (revealed?.id === c.id) return setRevealed(null)
    try {
      setRevealed({ id: c.id, password: await call('passwords', 'reveal', c.id) })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  const copyPassword = async (c: CredentialView): Promise<void> => {
    try {
      await call('passwords', 'copyPassword', c.id)
      toast.show({ tone: 'success', message: t('passwords.copied.password') })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  const copyUsername = async (c: CredentialView): Promise<void> => {
    try {
      await navigator.clipboard.writeText(c.username)
      toast.show({ tone: 'success', message: t('passwords.copied.username') })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  const remove = async (c: CredentialView): Promise<void> => {
    const ok = await confirm({
      title: t('passwords.delete.title'),
      message: t('passwords.delete.body', { username: c.username || t('passwords.row.noUsername'), site: siteOfOrigin(c.origin) }),
      destructive: true,
    })
    if (!ok) return
    try {
      await call('passwords', 'remove', c.id)
      list.set(items.filter((x) => x.id !== c.id))
      toast.show({ tone: 'success', message: t('passwords.deleted') })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  const openMenu = (c: CredentialView, anchor: HTMLElement | { x: number; y: number }): void => {
    const menu = [
      { id: 'copy-user', label: t('passwords.row.copyUsername'), enabled: c.username !== '' },
      { id: 'copy-password', label: t('passwords.row.copyPassword') },
      { id: 'open', label: t('passwords.row.open') },
      { id: 'edit', label: t('passwords.row.edit') },
      { id: 'delete', label: t('passwords.row.delete'), danger: true },
    ]
    void showMenu(menu, anchor).then((id) => {
      if (id === 'copy-user') void copyUsername(c)
      else if (id === 'copy-password') void copyPassword(c)
      else if (id === 'open') void atelier.tabs.create(c.origin, { afterId: tabId })
      else if (id === 'edit') setEditing(c)
      else if (id === 'delete') void remove(c)
    })
  }
  const importMenu = (anchor: HTMLElement): void => {
    const options = [{ id: 'csv', label: t('passwords.import.fromCsv') }, ...(isMac ? [{ id: 'system', label: t('passwords.import.fromSystem') }] : [])]
    void showMenu(options, anchor).then((id) => {
      if (id === 'csv' || id === 'system') onImport(id)
    })
  }
  const clearSite = (): void => void atelier.nav.go(tabId, 'atelier://passwords')

  return (
    <>
      <div className="sp-toolbar">
        <SearchField value={search} onChange={setSearch} placeholder={t('passwords.filter')} />
        {site && (
          <span className="pw-site-chip">
            {t('passwords.site.chip', { site })}
            <IconButton size="sm" label={t('passwords.site.clear')} icon={<X />} onClick={clearSite} />
          </span>
        )}
        <Select<Sort>
          aria-label={t('passwords.sort.label')}
          value={sort}
          options={[
            { value: 'site', label: t('passwords.sort.site') },
            { value: 'recent', label: t('passwords.sort.recent') },
          ]}
          onChange={setSort}
        />
        <Button icon={<Upload />} onClick={(e) => importMenu(e.currentTarget)}>
          {t('passwords.import')}
        </Button>
        <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
          {t('passwords.add')}
        </Button>
      </div>
      {site && list.data !== null && items.length === 0 ? (
        <ListFrame>
          <EmptyState
            icon={<KeyRound />}
            title={t('passwords.empty.site', { site })}
            action={
              <>
                <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
                  {t('passwords.add')}
                </Button>
                <Button onClick={clearSite}>{t('passwords.site.clear')}</Button>
              </>
            }
          />
        </ListFrame>
      ) : (
      <ListState
        items={list.data}
        shown={shown.length}
        error={list.error}
        onRetry={list.reload}
        loadingLabel={t('passwords.loading')}
        avatar
        onClearFilters={search || site ? () => (search ? setSearch('') : clearSite()) : undefined}
        empty={
          <EmptyState
            icon={<KeyRound />}
            title={t('passwords.empty.logins')}
            description={t('passwords.empty.loginsBody')}
            action={
              <Button variant="primary" icon={<Upload />} onClick={() => onImport('csv')}>
                {t('passwords.empty.import')}
              </Button>
            }
          />
        }
      >
        <p className="sp-section__note" aria-live="polite">
          {t('passwords.count', { count: shown.length })}
        </p>
        <ListFrame label={t('passwords.page.title')}>
          {shown.map((c) => {
            const host = siteOfOrigin(c.origin)
            const isShown = revealed?.id === c.id
            return (
              <div key={c.id} className="sp-item" onContextMenu={(e) => {
                  e.preventDefault()
                  openMenu(c, e.clientX === 0 && e.clientY === 0 ? e.currentTarget : { x: e.clientX, y: e.clientY })
                }}>
                <span className="sp-favicon" aria-hidden>
                  {siteInitial(c.origin)}
                </span>
                <button type="button" className="sp-item__main" onClick={() => setEditing(c)} aria-label={`${host}, ${c.username || t('passwords.row.noUsername')}`}>
                  <span className="sp-item__title">
                    <span className="sp-item__title-text">{host}</span>
                  </span>
                  <span className={c.username ? 'sp-item__sub' : 'sp-item__sub pw-row__username--none'}>{c.username || t('passwords.row.noUsername')}</span>
                  {isShown && revealed && <span className="pw-row__secret">{revealed.password}</span>}
                </button>
                <span className="sp-item__meta">{t('passwords.row.changed', { date: new Date(c.updatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) })}</span>
                <div className="sp-item__actions">
                  <IconButton size="sm" label={isShown ? t('passwords.row.hide') : t('passwords.row.reveal')} pressed={isShown} icon={isShown ? <EyeOff /> : <Eye />} onClick={() => void reveal(c)} />
                  <IconButton size="sm" label={t('passwords.row.copyPassword')} icon={<Copy />} onClick={() => void copyPassword(c)} />
                  <IconButton size="sm" label={t('passwords.row.edit')} icon={<Pencil />} onClick={() => setEditing(c)} />
                  <IconButton size="sm" label={t('passwords.row.delete')} icon={<Trash2 />} tone="danger" onClick={() => void remove(c)} />
                  <IconButton size="sm" label={t('passwords.row.more', { site: host })} icon={<Ellipsis />} onClick={(e) => openMenu(c, e.currentTarget)} />
                </div>
              </div>
            )
          })}
        </ListFrame>
      </ListState>
      )}
      <CredentialDialog
        open={editing !== null}
        editing={editing === 'new' ? null : editing}
        site={site}
        onClose={() => setEditing(null)}
        onSaved={(saved, added) => {
          setEditing(null)
          if (revealed?.id === saved.id) setRevealed(null)
          void list.reload()
          toast.show({ tone: 'success', message: added ? t('passwords.saved') : t('passwords.updated') })
        }}
      />
    </>
  )
}
