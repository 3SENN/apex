/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Privacy (ST-36): ad and tracker blocking, the way into site
// settings, the tracking and clear-on-exit sections, history, and the two
// website-data actions. Each clear asks first, spins while it runs and ends
// with a toast; ⇧⌘⌫ (or ?clear=1) opens the full clear-browsing-data dialog.
// atelier://settings/sites shows the site settings inside this page, and
// atelier://settings/access every permission (this Mac's and the websites').
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { ArrowLeft, Cookie, Eraser, History, ShieldCheck, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { ClearDataRequest } from '@shared/services/settings'
import { call } from '../../api'
import { useT } from '../../i18n/useT'
import { Button, Kbd, useAsyncAction, useConfirm, useToast } from '../../ui'
import { ClearDataDialog } from '../ClearDataDialog'
import { Card, Row, PageHeader, Section, SwitchRow } from '../kit'
import { CLEAR_CACHE, CLEAR_SITE_DATA } from '../logic/clearData'
import type { SettingsPageProps } from '../pageTypes'
import { PrivacySections } from '../sections/privacy/PrivacySections'
import { PrivacyPackSections } from '../sections/privacy/PrivacyPackSections' // privacy pack
import { CrashReportsRow } from '../../diagnostics/CrashReportsRow'
import { SiteSettingsPage } from './SiteSettingsPage'
import { PermissionsHubPage } from '../permissions/PermissionsHubPage'

export interface PrivacyPageProps extends SettingsPageProps {
  /** 'sites' for atelier://settings/sites, 'access' for atelier://settings/access; null for the page itself. */
  view: string | null
  /** ?clear=1: open the clear-browsing-data dialog on arrival. */
  openClear: boolean
  onOpenSection(id: string): void
}

/** Splits a string at {keys} and puts the shortcut's key caps there. */
function withKeys(text: string, shortcut: string): ReactNode {
  const [before, after] = text.split('{keys}')
  return (
    <>
      {before}
      <Kbd shortcut={shortcut} />
      {after}
    </>
  )
}

export function PrivacyPage({ settings, update, tabId, view, openClear, onOpenSection }: PrivacyPageProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const ask = useConfirm()
  const [dialog, setDialog] = useState(openClear)
  useEffect(() => {
    if (openClear) setDialog(true)
  }, [openClear])

  // One action per kind of clear, so each button spins on its own.
  const clearWith = (request: ClearDataRequest, title: string, message: string, button: string, done: string) =>
    async (): Promise<void> => {
      if (!(await ask({ title, message, confirmLabel: button, destructive: true }))) return
      await call('storage', 'clearBrowsingData', request)
      toast.show({ tone: 'success', message: done })
    }
  const cache = useAsyncAction(
    clearWith(CLEAR_CACHE, t('settings.privacy.cache.confirm.title'), t('settings.privacy.cache.confirm.message'), t('settings.privacy.cache.button'), t('settings.privacy.cache.done')),
    { toastErrors: true },
  )
  const cookies = useAsyncAction(
    clearWith(CLEAR_SITE_DATA, t('settings.privacy.cookies.confirm.title'), t('settings.privacy.cookies.confirm.message'), t('settings.privacy.cookies.button'), t('settings.privacy.cookies.done')),
    { toastErrors: true },
  )
  const history = useAsyncAction(
    async () => {
      const ok = await ask({ title: t('settings.privacy.history.confirm.title'), message: t('settings.privacy.history.confirm.message'), confirmLabel: t('settings.privacy.history.confirm.button'), destructive: true })
      if (!ok) return
      await call('history', 'clear')
      toast.show({ tone: 'success', message: t('settings.privacy.history.cleared') })
    },
    { toastErrors: true },
  )

  if (view === 'sites' || view === 'access') {
    return (
      <>
        <Button className="sp-back" size="sm" variant="ghost" icon={<ArrowLeft />} onClick={() => onOpenSection('privacy')}>
          {t('settings.privacy.title')}
        </Button>
        {view === 'sites' ? <SiteSettingsPage settings={settings} update={update} tabId={tabId} /> : <PermissionsHubPage settings={settings} update={update} tabId={tabId} />}
      </>
    )
  }

  return (
    <>
      <PageHeader title={t('settings.privacy.title')} description={t('settings.privacy.description')} />
      <Section title={t('settings.privacy.blocking')}>
        <Card>
          <SwitchRow
            anchor="adblock"
            label={t('settings.privacy.adblock')}
            description={t('settings.privacy.adblock.description')}
            checked={settings.adblock}
            onChange={(adblock) => void update({ adblock })}
          />
          <Row anchor="site-settings" icon={<SlidersHorizontal />} title={t('settings.privacy.sites')} description={t('settings.privacy.sites.description')}>
            <Button size="sm" variant="secondary" onClick={() => onOpenSection('sites')}>
              {t('settings.privacy.sites.open')}
            </Button>
          </Row>
          <Row anchor="permissions-hub" icon={<ShieldCheck />} title={t('permissionsHub.row.title')} description={t('permissionsHub.row.description')}>
            <Button size="sm" variant="secondary" onClick={() => onOpenSection('access')}>
              {t('permissionsHub.row.open')}
            </Button>
          </Row>
        </Card>
      </Section>

      {/* Privacy pack: HTTPS-First and cookie banners. */}
      <PrivacyPackSections settings={settings} update={update} tabId={tabId} />

      <PrivacySections settings={settings} update={update} tabId={tabId} />

      <Section title={t('settings.privacy.history')}>
        <Card>
          <Row anchor="history" icon={<History />} title={t('settings.privacy.history.row')} description={withKeys(t('settings.privacy.history.description'), 'CmdOrCtrl+Y')}>
            <Button size="sm" variant="secondary" loading={history.busy} onClick={() => void history.run()}>
              {t('settings.privacy.history.clear')}
            </Button>
          </Row>
        </Card>
      </Section>

      <Section title={t('settings.privacy.data')}>
        <Card>
          <Row anchor="clear-cache" icon={<Eraser />} title={t('settings.privacy.cache')} description={t('settings.privacy.cache.description')}>
            <Button size="sm" variant="secondary" loading={cache.busy} onClick={() => void cache.run()}>
              {t('settings.privacy.cache.button')}
            </Button>
          </Row>
          <Row anchor="clear-cookies" icon={<Cookie />} title={t('settings.privacy.cookies')} description={
              <>
                {t('settings.privacy.cookies.description')} <span className="sp-warn-text">{t('settings.privacy.cookies.warning')}</span>
              </>
            }
          >
            <Button size="sm" variant="secondary" loading={cookies.busy} onClick={() => void cookies.run()}>
              {t('settings.privacy.cookies.button')}
            </Button>
          </Row>
          <Row anchor="clear-browsing-data" icon={<Trash2 />} title={t('settings.privacy.clearAll')} description={withKeys(t('settings.privacy.clearAll.description'), 'CmdOrCtrl+Shift+Backspace')}>
            <Button size="sm" variant="secondary" onClick={() => setDialog(true)} aria-haspopup="dialog">
              {t('settings.privacy.clearAll.button')}
            </Button>
          </Row>
        </Card>
      </Section>

      {/* DG-03: crash reports are off by default; turning them off deletes kept reports. */}
      <CrashReportsRow settings={settings} update={update} />

      <ClearDataDialog open={dialog} onClose={() => setDialog(false)} />
    </>
  )
}
