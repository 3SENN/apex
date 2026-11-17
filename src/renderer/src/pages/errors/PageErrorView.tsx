/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useState, type ReactElement } from 'react'
import { Ban, CircleAlert, Clock, LockOpen, Repeat, SearchX, ServerCrash, ShieldAlert, ShieldX, WifiOff, type LucideIcon } from 'lucide-react'
import type { TabInfo } from '@shared/ipc'
import type { PageErrorDetails } from '@shared/safety'
import { searchUrl } from '@shared/url'
import { apex, call, errorText, useAppEvent } from '../../api'
import { useCompanions } from '../../components/shellContext'
import { FaceAvatar } from '../../companion/FaceAvatar'
import { useCompanionImage } from '../../companion/images'
import { useT } from '../../i18n/useT'
import { Button, Spinner, cx, formatAbsolute, useToast } from '../../ui'
import { ACTION_LABEL, displayHostOf, errorCopy, originOf, type ErrorAction, type ErrorView } from './logic'
import './errors.css'

// The page Apex draws in a tab's pane when its page failed, crashed or was
// stopped on purpose (SS-07). It is not a
// route: the failed address stays the tab's URL, so the pill and history
// keep it, and main hides the page view while this shows. The companion
// stands in with its sad mood (the 2D face while its still renders).

const ICONS: Record<ErrorView, LucideIcon> = {
  offline: WifiOff,
  'not-found': SearchX,
  refused: Ban,
  'timed-out': Clock,
  'too-many-redirects': Repeat,
  'blocked-by-adblock': ShieldX,
  'dangerous-site': ShieldAlert,
  certificate: ShieldAlert,
  'https-unavailable': LockOpen, // privacy pack
  crashed: ServerCrash,
  other: CircleAlert,
}

/** Whether the chrome draws this tab's pane (App mounts PageErrorView then). */
export function showsPageError(tab: Pick<TabInfo, 'pageError' | 'crashed'>): boolean {
  return tab.pageError !== null || tab.crashed
}

function useOnline(): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    let live = true
    void call('network', 'isOnline').then(
      (v) => live && setOnline(v),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])
  useAppEvent('online', (e) => setOnline(e.online))
  return online
}

function ErrorFigure(): ReactElement {
  const companions = useCompanions()
  const companion = companions.list.find((c) => c.id === companions.activeId) ?? companions.list[0] ?? null
  if (!companion) return <span className="perr__figure perr__figure--empty" aria-hidden="true" />
  return <SadCompanion look={companion.look} name={companion.name} />
}

function SadCompanion({ look, name }: { look: Parameters<typeof useCompanionImage>[0]; name: string }): ReactElement {
  const size = 120
  // Twice the CSS size keeps it sharp on any display.
  const px = size * 2
  const src = useCompanionImage(look, px, { mood: 'sad', framing: 'bust' })
  return (
    <span className="perr__figure" aria-hidden="true">
      {src ? <img src={src} alt="" width={size} height={size} draggable={false} /> : <FaceAvatar look={look} name={name} size={72} mood="sad" mark={null} label="" />}
    </span>
  )
}

export function PageErrorView({ tab, searchEngine }: { tab: TabInfo; searchEngine: string }): ReactElement | null {
  const t = useT()
  const toast = useToast()
  const titleId = useId()
  const online = useOnline()
  const [details, setDetails] = useState<PageErrorDetails | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ErrorAction | 'proceed' | null>(null)

  const error = tab.pageError
  const view: ErrorView | null = tab.crashed ? 'crashed' : (error?.kind ?? null)
  const url = error?.url ?? tab.url
  const host = displayHostOf(url)
  const detailsKey = error ? `${error.kind}:${error.code}:${error.url}` : ''

  useEffect(() => {
    setOpen(false)
    setDetails(null)
    if (!detailsKey || tab.crashed) return
    let live = true
    void call('pageErrors', 'details', tab.id).then(
      (d) => live && setDetails(d),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [detailsKey, tab.id, tab.crashed])

  // A finished load clears the busy state, whatever it ended in.
  useEffect(() => {
    if (!tab.loading) setBusy(null)
  }, [tab.loading])

  if (!view) return null
  const copy = errorCopy(view, tab.canGoBack)
  const Icon = ICONS[view]

  const run = async (action: ErrorAction | 'proceed', fn: () => Promise<unknown>): Promise<void> => {
    setBusy(action)
    try {
      await fn()
    } catch (err) {
      setBusy(null)
      toast.show({ tone: 'error', message: t('safety.error.failed', { message: errorText(err) }) })
    }
  }

  const act = (action: ErrorAction): void => {
    switch (action) {
      case 'retry':
      case 'reload':
        void run(action, () => call('pageErrors', 'retry', tab.id))
        return
      case 'back':
        void run(action, () => apex.nav.back(tab.id))
        return
      case 'back-to-safety':
        void run(action, () => call('pageErrors', 'leave', tab.id))
        return
      case 'search':
        void run(action, () => apex.nav.go(tab.id, searchUrl(host, searchEngine)))
        return
      // Privacy pack (HTTPS-First): Continue to site remembers the site and loads the http address; Go back leaves (or closes to a blank page).
      case 'continue-insecure':
        void run(action, () => call('pageErrors', 'proceed', tab.id))
        return
      case 'go-back':
        void run(action, () => call('pageErrors', 'leave', tab.id))
        return
      case 'allow-adblock':
        void run(action, () => call('pageErrors', 'allowAdblock', tab.id))
        return
      case 'clear-cookies': {
        const origin = originOf(url)
        if (!origin) return
        // Clearing reloads every page of the site, this one included.
        void run(action, async () => {
          await call('sites', 'clearSiteData', origin)
          toast.show({ tone: 'success', message: t('safety.error.cookiesCleared') })
        })
        return
      }
    }
  }

  const waiting = view === 'offline' && !online
  const retrying = tab.loading || busy === 'retry' || busy === 'reload'
  const status = waiting ? t('safety.error.offline.waiting') : retrying ? t('safety.error.retrying') : ''
  const codeName = details?.codeName ?? null

  return (
    <div className={cx('perr', `perr--${copy.tone}`)} role="region" aria-labelledby={titleId}>
      <div className="perr__body">
        <ErrorFigure />
        <span className="perr__badge" aria-hidden="true">
          <Icon size={16} strokeWidth={2} />
        </span>
        <h1 id={titleId} className="perr__title">
          {t(copy.title, { host })}
        </h1>
        <p className="perr__text">{t(copy.body, { host })}</p>
        {/* The reason, the address and the code (SS-07); interstitials keep the code in their details. */}
        <p className="perr__url">
          <span className="perr__mono">{url}</span>
          {!copy.bypass && codeName && <span className="perr__mono perr__url-code">{codeName}</span>}
        </p>
        <p className="perr__status" role="status" aria-live="polite">
          {status && (
            <>
              <Spinner size={12} /> {status}
            </>
          )}
        </p>
        <div className="perr__actions">
          {copy.secondary.map((a) => (
            <Button key={a} variant="secondary" disabled={busy !== null && busy !== a} loading={busy === a && a !== 'retry'} onClick={() => act(a)}>
              {t(ACTION_LABEL[a])}
            </Button>
          ))}
          <Button variant="primary" autoFocus={copy.tone === 'danger'} disabled={busy !== null && busy !== copy.primary} loading={busy === copy.primary && !retrying} onClick={() => act(copy.primary)}>
            {t(ACTION_LABEL[copy.primary])}
          </Button>
        </div>
        {copy.bypass && (
          <div className="perr__more">
            <button type="button" className="perr__toggle" aria-expanded={open} aria-controls={`${titleId}-more`} onClick={() => setOpen((o) => !o)}>
              {open ? t('safety.error.hideDetails') : t('safety.error.details')}
            </button>
            {open && (
              <div id={`${titleId}-more`} className="perr__details">
                {codeName && <p className="perr__code">{t('safety.error.code', { code: codeName })}</p>}
                {view === 'certificate' && <CertificateTable details={details} />}
                <p className="perr__note">{copy.bypass === 'proceed' ? t('safety.error.proceedNote') : t('safety.error.dangerousNote')}</p>
                <button
                  type="button"
                  className="perr__bypass"
                  disabled={busy !== null}
                  onClick={() => void run('proceed', () => call('pageErrors', 'proceed', tab.id))}
                >
                  {copy.bypass === 'proceed' ? t('safety.error.proceed', { host }) : t('safety.error.visitAnyway', { host })}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function CertificateTable({ details }: { details: PageErrorDetails | null }): ReactElement {
  const t = useT()
  const cert = details?.certificate
  if (!cert) return <p className="perr__note">{t('safety.cert.none')}</p>
  return (
    <dl className="perr__cert">
      <dt>{t('safety.cert.subject')}</dt>
      <dd>{cert.subject || '—'}</dd>
      <dt>{t('safety.cert.issuer')}</dt>
      <dd>{cert.issuer || '—'}</dd>
      <dt>{t('safety.cert.valid')}</dt>
      <dd>{t('safety.cert.validRange', { from: formatAbsolute(cert.validFrom), to: formatAbsolute(cert.validTo) })}</dd>
      <dt>{t('safety.cert.fingerprint')}</dt>
      <dd className="perr__mono">{cert.sha256}</dd>
    </dl>
  )
}
