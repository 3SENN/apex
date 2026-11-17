/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { SiteSettings, SiteToggle } from '@shared/sites'
import { useT } from '../../../i18n/useT'
import { Select } from '../../../ui'
import { Card, Row, Section } from '../../kit'

// Per-site content rules: JavaScript, images, automatic
// downloads and insecure content, each Default, Allow or Block. Main's
// webRequest mux and download handler read them on the next request, so a
// change applies on the next load. The site editor (Settings › Sites) and
// site info mount this with the site's settings and their own save.

export type SiteContentKey = 'javascript' | 'images' | 'automaticDownloads' | 'insecureContent'

const ROWS: { key: SiteContentKey; title: 'safety.content.javascript' | 'safety.content.images' | 'safety.content.automaticDownloads' | 'safety.content.insecureContent'; body: 'safety.content.javascriptBody' | 'safety.content.imagesBody' | 'safety.content.automaticDownloadsBody' | 'safety.content.insecureContentBody' }[] = [
  { key: 'javascript', title: 'safety.content.javascript', body: 'safety.content.javascriptBody' },
  { key: 'images', title: 'safety.content.images', body: 'safety.content.imagesBody' },
  { key: 'automaticDownloads', title: 'safety.content.automaticDownloads', body: 'safety.content.automaticDownloadsBody' },
  { key: 'insecureContent', title: 'safety.content.insecureContent', body: 'safety.content.insecureContentBody' },
]

const CHOICES: readonly SiteToggle[] = ['default', 'allow', 'block']

export function SiteContentRules({ settings, onChange, disabled = false, bare = false }: {
  settings: Pick<SiteSettings, SiteContentKey>
  onChange(patch: Partial<Pick<SiteSettings, SiteContentKey>>): void
  disabled?: boolean
  /** Rows only, for a surface that draws its own heading and card (site info). */
  bare?: boolean
}): ReactElement {
  const t = useT()
  const options = CHOICES.map((c) => ({ value: c, label: t(`safety.content.${c}`) }))
  const rows = ROWS.map((row) => {
    const title = t(row.title)
    return (
      <Row key={row.key} title={title} description={t(row.body)} anchor={`site-content-${row.key}`}>
        <Select size="sm" aria-label={title} value={settings[row.key]} options={options} disabled={disabled} onChange={(v) => onChange({ [row.key]: v })} />
      </Row>
    )
  })
  if (bare) return <>{rows}</>
  return (
    <Section title={t('safety.content.title')}>
      <Card>{rows}</Card>
    </Section>
  )
}
