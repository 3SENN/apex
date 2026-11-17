/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement } from 'react'
import { ExternalLink } from 'lucide-react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { BRANDING } from '@shared/branding'
import { ART_LICENSE_NAME, PRIVACY_URL, RELEASE, SOURCE_URL } from '@shared/release'
import type { AboutInfo } from '@shared/services/settings'
import { atelier, call } from '../../api'
import { BrandLogo } from '../../brand/BrandLogo'
import { AboutDiagnostics } from '../../diagnostics/AboutDiagnostics'
import { MigrationResults } from '../../migrations/MigrationResults'
import { Button, ErrorState, IconButton, SkeletonRows } from '../../ui'
import { useT } from '../../i18n/useT'
import { UpdateSection } from '../../updates/UpdateSection'
import { updatesVisible } from '../../updates/logic/labels'
import { useUpdateStatus } from '../../updates/useUpdateStatus'
import { parseLicenses, trademarkLine, type LicenseEntry } from '../../updates/logic/licenses'
import { useResource } from '../data'
import { Card, PageHeader, Row, Section } from '../kit'

// Settings › About Atelier (ST-56): the version with the
// update row and the auto-download switch, the website, the privacy notice,
// Report a problem and View logs, the data updates after a chat-store
// migration, the source notice (the code's MPL and the companion art's
// licence), Chromium's licences, the licences generated at build time
// (licenses.json, the companion art's included), and the branding's
// copyright and trademark lines.

/** Only an https website gets a row: about.info() when it answers, else the release config. */
function websiteUrl(fromInfo: string | undefined): string | null {
  const url = fromInfo || RELEASE.website
  return /^https:\/\/[^\s]+$/.test(url) ? url : null
}

const PLATFORMS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

/** "Chromium 140 · macOS arm64": the engine Atelier shows, never the framework under it. */
export function runtimeLine(info: Pick<AboutInfo, 'chromium' | 'platform' | 'arch'>): string {
  const parts = [info.chromium && `Chromium ${info.chromium.split('.')[0]}`, `${PLATFORMS[info.platform] ?? info.platform} ${info.arch}`.trim()]
  return parts.filter(Boolean).join(' · ')
}

export function AboutPage({ settings, update }: { settings: SettingsView; update(patch: SettingsPatch): Promise<void> }): ReactElement {
  const t = useT()
  const status = useUpdateStatus()
  // The version and runtime details; the page works without them.
  const info = useResource(() => call('about', 'info'))
  const website = websiteUrl(info.data?.website)
  const showPrivacy = updatesVisible(status) && status.disabledReason !== 'unsupported-package'
  const version = info.data?.version || status?.currentVersion || ''
  const chromiumLicenses = info.data?.chromiumLicenses ?? ''
  const trademarks = trademarkLine(BRANDING.trademarkInfo, t)
  return (
    <>
      <PageHeader title={t('updates.about.title')} description={t('updates.about.description')} />
      <div className="about-brand">
        <BrandLogo size={32} />
      </div>
      <Section note={showPrivacy ? t('updates.about.privacy') : undefined}>
        <Card>
          <UpdateSection settings={settings} update={update} versionDetail={info.data ? runtimeLine(info.data) : null} />
          {website && (
            <Row title={t('updates.about.website')} description={t('updates.about.websiteBody')}>
              <IconButton label={t('updates.about.website')} icon={<ExternalLink size={16} />} onClick={() => void atelier.tabs.create(website)} />
            </Row>
          )}
          <Row title={t('updates.about.privacyTitle')} description={t('updates.about.privacyBody')}>
            <IconButton label={t('updates.about.openPrivacy')} icon={<ExternalLink size={16} />} onClick={() => void atelier.tabs.create(PRIVACY_URL)} />
          </Row>
          <AboutDiagnostics />
        </Card>
      </Section>
      <MigrationResults />
      <Section title={t('updates.licenses.title')}>
        <Card>
          {version && (
            <Row title={t('updates.licenses.sourceTitle')} description={t('updates.licenses.source', { url: SOURCE_URL, version, artLicense: ART_LICENSE_NAME })}>
              <IconButton label={t('updates.licenses.openSource')} icon={<ExternalLink size={16} />} onClick={() => void atelier.tabs.create(SOURCE_URL)} />
            </Row>
          )}
          {chromiumLicenses && (
            <Row title={t('updates.licenses.chromiumTitle')} description={t('updates.licenses.chromiumBody')}>
              <IconButton label={t('updates.licenses.openChromium')} icon={<ExternalLink size={16} />} onClick={() => void atelier.tabs.create(chromiumLicenses)} />
            </Row>
          )}
          <Licenses />
        </Card>
      </Section>
      <p className="about-footer">{t('updates.about.footer')}</p>
      <p className="about-footer about-footer--legal">
        {BRANDING.copyright}
        {trademarks && (
          <>
            <br />
            {trademarks}
          </>
        )}
      </p>
    </>
  )
}

/** licenses.json from the build (scripts/licenses.mjs); missing in builds that skipped it. */
async function loadLicenses(): Promise<LicenseEntry[] | null> {
  const res = await fetch(new URL('licenses.json', document.baseURI).href)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parseLicenses(await res.json())
}

function Licenses(): ReactElement {
  const t = useT()
  const list = useResource(loadLicenses)
  const [open, setOpen] = useState(false)
  if (list.loading && !list.data) return <SkeletonRows rows={1} label={t('updates.licenses.title')} />
  if (list.error) return <ErrorState compact message={t('updates.licenses.error')} onRetry={() => list.reload()} />
  const items = list.data
  if (!items || items.length === 0) return <Row title={t('updates.licenses.title')} description={t('updates.licenses.missing')} />
  return (
    <>
      <Row title={t('updates.licenses.count', { count: items.length })} description={t('updates.licenses.body')}>
        <Button variant="secondary" size="sm" aria-expanded={open} aria-controls="about-licenses" onClick={() => setOpen(!open)}>
          {open ? t('updates.licenses.hide') : t('updates.licenses.show')}
        </Button>
      </Row>
      {open && (
        <ul id="about-licenses" className="about-licenses">
          {items.map((item) => (
            <li key={`${item.name}@${item.version}`}>
              <details>
                <summary>
                  <span>{item.name}</span>
                  <span className="about-licenses__meta">
                    {item.version} · {item.license}
                  </span>
                </summary>
                {item.text && <pre>{item.text}</pre>}
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
