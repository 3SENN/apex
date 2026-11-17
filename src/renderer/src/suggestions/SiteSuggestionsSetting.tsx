/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The opt-in for site suggestions (OV-23), shown in the "This Mac" card of
// Agent permissions next to Calendar and Reminders: off by default; when on,
// a site that matches a connector or a desktop app on this Mac gets an offer.
// It also shows a snooze and the sites turned off, with a way back.
import { useState, type ReactElement } from 'react'
import { Lightbulb } from 'lucide-react'
import type { SiteSuggestionSettings } from '@shared/siteSuggestions'
import { call, errorText } from '../api'
import { t } from '../i18n/useT'
import { useResource } from '../settings/data'
import { Button, Switch } from '../ui'
import '../apps/platform.css'

export function SiteSuggestionsSetting(): ReactElement | null {
  const settings = useResource<SiteSuggestionSettings>(() => call('siteSuggestions', 'settings'))
  const [error, setError] = useState<string | null>(null)
  if (!settings.data) return null
  const data = settings.data
  const update = async (patch: Partial<SiteSuggestionSettings>): Promise<void> => {
    setError(null)
    try {
      settings.set(await call('siteSuggestions', 'update', patch))
    } catch (err) {
      setError(errorText(err))
    }
  }
  const snoozed = data.enabled && data.snoozedUntil !== null && data.snoozedUntil > Date.now()

  return (
    <div className="pl-access__row" data-settings-anchor="site-suggestions">
      <span className="pl-access__icon">
        <Lightbulb aria-hidden />
      </span>
      <span className="pl-access__text">
        <p className="pl-access__title" id="pl-site-suggestions">
          {t('platform.suggestion.setting.title')}
        </p>
        <p className="pl-access__desc">{t('platform.suggestion.setting.detail')}</p>
        {(snoozed || data.offSites.length > 0) && (
          <span className="pl-access__state">
            {snoozed && (
              <>
                <span className="pl-access__desc">{t('platform.suggestion.setting.snoozed', { time: new Date(data.snoozedUntil ?? 0).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) })}</span>
                <Button size="sm" variant="ghost" onClick={() => void update({ snoozedUntil: null })}>
                  {t('platform.suggestion.setting.resume')}
                </Button>
              </>
            )}
            {data.offSites.length > 0 && (
              <>
                <span className="pl-access__desc" title={data.offSites.join(', ')}>
                  {t('platform.suggestion.setting.offSites', { count: data.offSites.length })}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void update({ offSites: [] })}>
                  {t('platform.suggestion.setting.clearSites')}
                </Button>
              </>
            )}
          </span>
        )}
        {error && (
          <span className="pl-error" role="alert">
            {error}
          </span>
        )}
      </span>
      <Switch checked={data.enabled} onChange={(on) => void update({ enabled: on, ...(on ? { snoozedUntil: null } : {}) })} aria-label={t('platform.suggestion.setting.title')} />
    </div>
  )
}
