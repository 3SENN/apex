/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useId, useState, type ReactElement } from 'react'
import { MousePointerClick, SlidersHorizontal } from 'lucide-react'
import { tweaksUrl, type TweakTabInfo } from '@shared/tweaks'
import { atelier, call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Button, Switch } from '../ui'
import { tweakSummary } from './logic'
import './tweaks.css'

// The Tweaks section of site info (TWK-04): whether the site is tweaked, what
// its tweak changes, Hide elements (starts the picker in the page and closes
// the popover), Focus as a quick switch, and Customize for atelier://tweaks.
// Nothing on Atelier's own pages; a line saying why on sign-in pages.

export function SiteTweakSection({ tabId, close }: { tabId: string; close(): void }): ReactElement | null {
  const t = useT()
  const titleId = useId()
  const [info, setInfo] = useState<TweakTabInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setInfo(await call('tweaks', 'forTab', tabId))
    } catch (err) {
      setError(errorText(err))
    }
  }, [tabId])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(
    () =>
      atelier.onAppEvent((event) => {
        if (event.type === 'tweaks') void load()
      }),
    [load],
  )

  if (!info || info.blocked === 'internal' || info.blocked === 'not-web' || !info.host) return null
  const host = info.host
  const tweak = info.tweak

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errorText(err))
    }
  }
  const pick = (): Promise<void> =>
    act(async () => {
      if (await call('tweaks', 'hideElements', tabId)) close()
      else setError(t('tweaks.site.hideFailed'))
    })
  const setFocus = (focus: boolean): Promise<void> =>
    act(async () => {
      const target = tweak ?? (await call('tweaks', 'create', host))
      await call('tweaks', 'update', target.id, { style: { focus }, ...(focus ? { enabled: true } : {}) })
    })

  return (
    <section className="st-section twk-site" aria-labelledby={titleId}>
      <h3 id={titleId} className="st-section__title">
        {t('tweaks.site.title')}
      </h3>
      {info.blocked === 'sign-in' ? (
        <p className="st-muted">{t('tweaks.site.signIn')}</p>
      ) : (
        <>
          {tweak ? (
            <Switch size="sm" label={t('tweaks.site.on')} description={tweakSummary(tweak)} checked={tweak.enabled} onChange={(enabled) => void act(() => call('tweaks', 'update', tweak.id, { enabled }))} />
          ) : (
            <p className="st-muted">{t('tweaks.site.intro')}</p>
          )}
          <Switch size="sm" label={t('tweaks.site.focus')} description={t('tweaks.site.focusBody')} checked={Boolean(tweak?.enabled && tweak.style.focus)} onChange={(focus) => void setFocus(focus)} />
          <div className="twk-site__actions">
            <Button size="sm" variant="secondary" icon={<MousePointerClick />} onClick={() => void pick()}>
              {t('tweaks.site.hide')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<SlidersHorizontal />}
              onClick={() => {
                void call('pages', 'open', tweaksUrl(host))
                close()
              }}
            >
              {t('tweaks.site.customize')}
            </Button>
          </div>
        </>
      )}
      {error && (
        <p className="st-note st-note--danger" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
