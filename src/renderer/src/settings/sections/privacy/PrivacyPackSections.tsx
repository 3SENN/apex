/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Cookie, Globe, LockKeyhole, RefreshCw } from 'lucide-react'
import type { SettingsPatch } from '@shared/ipc'
import { COOKIE_LISTS, type CookieListId, type CookieListStatus, type PrivacyExceptionKind, type PrivacyExceptions } from '@shared/privacyPack'
import { call, errorText } from '../../../api'
import { useT } from '../../../i18n/useT'
import { Button, formatRelative, useToast } from '../../../ui'
import { Card, Row, Section, SwitchRow } from '../../kit'
import type { SettingsPageProps } from '../../pageTypes'

// Settings › Privacy's privacy pack sections (src/main/privacy): HTTPS-First
// with the sites allowed without it, and Hide cookie banners with the
// optional community lists and the sites left alone. Every switch applies
// live: the next navigation for HTTPS-First, open pages at once for banners.

const NO_EXCEPTIONS: PrivacyExceptions = { https: [], cookieBanners: [] }

function ExceptionRows({ hosts, kind, onRemove }: { hosts: string[]; kind: PrivacyExceptionKind; onRemove(kind: PrivacyExceptionKind, host: string): void }): ReactElement {
  const t = useT()
  return (
    <>
      {hosts.map((host) => (
        <Row key={host} icon={<Globe />} title={host}>
          <Button size="sm" variant="ghost" aria-label={t('privacyPack.exception.removeLabel', { host })} onClick={() => onRemove(kind, host)}>
            {t('privacyPack.exception.remove')}
          </Button>
        </Row>
      ))}
    </>
  )
}

export function PrivacyPackSections({ settings, update }: SettingsPageProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const [exceptions, setExceptions] = useState<PrivacyExceptions>(NO_EXCEPTIONS)
  const [lists, setLists] = useState<CookieListStatus[]>([])
  const [updating, setUpdating] = useState(false)

  const save = (patch: SettingsPatch): void => {
    update(patch).catch((err: unknown) => toast.show({ tone: 'error', message: t('privacyPack.saveFailed', { message: errorText(err) }) }))
  }
  const loadLists = useCallback(async (): Promise<void> => {
    try {
      setLists(await call('privacy', 'cookieLists'))
    } catch {
      // The rows show "not downloaded yet" until the next try.
    }
  }, [])

  useEffect(() => {
    void call('privacy', 'exceptions').then(setExceptions, () => undefined)
  }, [])
  // A list turned on downloads in the background; its row follows until it finishes.
  const enabledKey = settings.cookieBannerLists.join(',')
  useEffect(() => {
    void loadLists()
  }, [loadLists, enabledKey])
  const busy = lists.some((l) => l.state === 'updating')
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void loadLists(), 1500)
    return () => clearInterval(timer)
  }, [busy, loadLists])

  const remove = (kind: PrivacyExceptionKind, host: string): void => {
    call('privacy', 'setException', kind, host, false).then(setExceptions, (err: unknown) => toast.show({ tone: 'error', message: t('privacyPack.saveFailed', { message: errorText(err) }) }))
  }
  const toggleList = (id: CookieListId, on: boolean): void => {
    const next = on ? [...new Set([...settings.cookieBannerLists, id])] : settings.cookieBannerLists.filter((l) => l !== id)
    save({ cookieBannerLists: next })
  }
  const updateNow = async (): Promise<void> => {
    setUpdating(true)
    try {
      setLists(await call('privacy', 'updateCookieLists'))
    } catch (err) {
      toast.show({ tone: 'error', message: t('privacyPack.saveFailed', { message: errorText(err) }) })
    } finally {
      setUpdating(false)
    }
  }
  const statusOf = (id: CookieListId): string => {
    const s = lists.find((l) => l.id === id)
    if (s?.state === 'updating') return t('privacyPack.cookies.listUpdating')
    if (s?.state === 'failed' && s.updatedAt === null) return t('privacyPack.cookies.listFailed')
    if (!s || s.updatedAt === null) return t('privacyPack.cookies.listNever')
    return t('privacyPack.cookies.listReady', { count: s.rules, when: formatRelative(s.updatedAt) })
  }

  return (
    <>
      <Section title={t('privacyPack.https.section')}>
        <Card>
          <SwitchRow
            anchor="https-first"
            label={t('privacyPack.https.label')}
            description={t('privacyPack.https.body')}
            checked={settings.httpsFirst}
            onChange={(httpsFirst) => save({ httpsFirst })}
          />
          <Row
            anchor="https-first-exceptions"
            icon={<LockKeyhole />}
            title={t('privacyPack.https.allowed')}
            description={exceptions.https.length ? t('privacyPack.https.allowedBody') : t('privacyPack.https.allowedNone')}
          />
          <ExceptionRows hosts={exceptions.https} kind="https" onRemove={remove} />
        </Card>
      </Section>
      <Section title={t('privacyPack.cookies.section')}>
        <Card>
          <SwitchRow
            anchor="cookie-banners"
            label={t('privacyPack.cookies.label')}
            description={t('privacyPack.cookies.body')}
            checked={settings.hideCookieBanners}
            onChange={(hideCookieBanners) => save({ hideCookieBanners })}
          />
          <Row anchor="cookie-lists" icon={<Cookie />} title={t('privacyPack.cookies.lists')} description={t('privacyPack.cookies.listsBody')}>
            {settings.cookieBannerLists.length > 0 && (
              <Button size="sm" variant="secondary" icon={<RefreshCw />} loading={updating || busy} onClick={() => void updateNow()}>
                {t('privacyPack.cookies.update')}
              </Button>
            )}
          </Row>
          {COOKIE_LISTS.map((list) => (
            <SwitchRow
              key={list.id}
              anchor={`cookie-list-${list.id}`}
              label={list.name}
              description={`${t('privacyPack.cookies.listSource', { source: list.source, licence: list.licence })} · ${statusOf(list.id)}`}
              checked={settings.cookieBannerLists.includes(list.id)}
              disabled={!settings.hideCookieBanners}
              onChange={(on) => toggleList(list.id, on)}
            />
          ))}
          <Row
            anchor="cookie-banner-exceptions"
            icon={<Globe />}
            title={t('privacyPack.cookies.shown')}
            description={exceptions.cookieBanners.length ? t('privacyPack.cookies.shownBody') : t('privacyPack.cookies.shownNone')}
          />
          <ExceptionRows hosts={exceptions.cookieBanners} kind="cookieBanners" onRemove={remove} />
        </Card>
      </Section>
    </>
  )
}
