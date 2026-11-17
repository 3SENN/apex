/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useId, useState, type ReactElement } from 'react'
import { Cookie, Lock, LockOpen, ShieldCheck, ShieldOff } from 'lucide-react'
import type { MessageKey } from '@shared/i18n/core'
import type { ConnectionSummary, CookieBannerState, PrivacySummary } from '@shared/privacyPack'
import { call } from '../../../api'
import { useT } from '../../../i18n/useT'
import { Switch } from '../../../ui'

// The privacy pack's summary in the site info popover: how the page was
// reached (HTTPS, upgraded by HTTPS-First, or plain HTTP), how many ads and
// trackers the blocker stopped on it, and what happened to its cookie banner,
// with the per-site switch for banners. It reads privacy.summary and polls
// briefly while the banner check is still running.

const CONNECTION: Record<ConnectionSummary, { title: MessageKey; body: MessageKey } | null> = {
  https: { title: 'privacyPack.summary.https', body: 'privacyPack.summary.httpsBody' },
  upgraded: { title: 'privacyPack.summary.upgraded', body: 'privacyPack.summary.upgradedBody' },
  'http-allowed': { title: 'privacyPack.summary.httpAllowed', body: 'privacyPack.summary.httpAllowedBody' },
  http: { title: 'privacyPack.summary.http', body: 'privacyPack.summary.httpBody' },
  none: null,
}

const BANNER: Record<CookieBannerState, MessageKey> = {
  rejected: 'privacyPack.summary.banner.rejected',
  hidden: 'privacyPack.summary.banner.hidden',
  checking: 'privacyPack.summary.banner.checking',
  none: 'privacyPack.summary.banner.none',
  allowed: 'privacyPack.summary.banner.allowed',
  off: 'privacyPack.summary.banner.off',
}

/** Polls while the banner check runs, at most this many times. */
const MAX_POLLS = 12

export function SitePrivacySummary({ tabId }: { tabId: string }): ReactElement | null {
  const t = useT()
  const titleId = useId()
  const [summary, setSummary] = useState<PrivacySummary | null>(null)
  const [polls, setPolls] = useState(0)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setSummary(await call('privacy', 'summary', tabId))
    } catch {
      setSummary(null)
    }
  }, [tabId])

  useEffect(() => {
    void load()
  }, [load])

  const checking = summary?.cookieBanner === 'checking'
  useEffect(() => {
    if (!checking || polls >= MAX_POLLS) return
    const timer = setTimeout(() => {
      setPolls((n) => n + 1)
      void load()
    }, 800)
    return () => clearTimeout(timer)
  }, [checking, polls, load])

  if (!summary) return null
  const connection = CONNECTION[summary.connection]
  const secure = summary.connection === 'https' || summary.connection === 'upgraded'
  const hidingHere = summary.cookieBanner !== 'allowed'

  const setHiding = async (on: boolean): Promise<void> => {
    setSaving(true)
    try {
      await call('privacy', 'setException', 'cookieBanners', summary.host, !on)
      setPolls(0)
      await load()
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="st-section" aria-labelledby={titleId}>
      <h3 id={titleId} className="st-section__title">
        {t('privacyPack.summary.title')}
      </h3>
      {connection && (
        <div className="st-row">
          <span className="st-row__glyph" aria-hidden>
            {secure ? <Lock size={15} /> : <LockOpen size={15} />}
          </span>
          <div className="st-row__text">
            <span className="st-row__title">{t(connection.title)}</span>
            <span className="st-row__desc">{t(connection.body)}</span>
          </div>
        </div>
      )}
      <div className="st-row">
        <span className="st-row__glyph" aria-hidden>
          {summary.blocking ? <ShieldCheck size={15} /> : <ShieldOff size={15} />}
        </span>
        <span className="st-row__title st-row__grow">{summary.blocking ? t('privacyPack.summary.trackers', { count: summary.trackersBlocked }) : t('privacyPack.summary.trackersOff')}</span>
      </div>
      <div className="st-row">
        <span className="st-row__glyph" aria-hidden>
          <Cookie size={15} />
        </span>
        <span className="st-row__title st-row__grow" role="status" aria-live="polite">
          {t(BANNER[summary.cookieBanner])}
        </span>
      </div>
      {summary.cookieBanner !== 'off' && (
        <Switch size="sm" label={t('privacyPack.summary.bannerSwitch')} checked={hidingHere} disabled={saving} onChange={(on) => void setHiding(on).catch(() => undefined)} />
      )}
    </section>
  )
}
