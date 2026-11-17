/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, type ReactElement } from 'react'
import { X } from 'lucide-react'
import { effectiveLanguages } from '@shared/languages'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { languageKey, toggleListed, type TranslateSettings } from '@shared/translate'
import { call } from '../api'
import { useLanguage, useT } from '../i18n/useT'
import { useResource } from '../settings/data'
import { Card, Row, Section } from '../settings/kit'
import { Button, IconButton, Select, Switch } from '../ui'
import { languageNamer, targetChoices } from './names'
import './translateSettings.css'

// Settings › Languages › Translation (TR-12): offer to translate, the target
// language, the companion engine (off by default: it sends page text to the
// model), where Apple's on-device languages are downloaded, and the always,
// never and never-on-these-sites lists, each entry removable.

const AUTO = 'auto'

export function TranslateSection({ settings, update }: { settings: SettingsView; update(patch: SettingsPatch): Promise<void> }): ReactElement {
  const t = useT()
  const { locale } = useLanguage()
  const name = useMemo(() => languageNamer(locale), [locale])
  const prefs = settings.translate
  const about = useResource(() => call('about', 'info'))
  const system = about.data?.systemLanguages.length ? about.data.systemLanguages : [...navigator.languages]
  const first = languageKey(effectiveLanguages(settings.languages, system)[0]) ?? 'en'
  const save = (next: Partial<TranslateSettings>): void => void update({ translate: { ...prefs, ...next } })
  const choices = [{ value: AUTO, label: t('translate.settings.target.auto', { language: name(first) }) }, ...targetChoices(name, prefs.target)]
  const mac = window.apex.platform === 'darwin'

  const list = (title: string, anchor: string, values: readonly string[], label: (v: string) => string, remove: (v: string) => void): ReactElement => (
    <Row anchor={anchor} title={title} stack>
      {values.length === 0 ? (
        <span className="trs__none">{t('translate.settings.none')}</span>
      ) : (
        <ul className="trs__chips" aria-label={title}>
          {values.map((v) => (
            <li key={v} className="trs__chip">
              <span className="trs__chip-name">{label(v)}</span>
              <IconButton size="sm" label={t('translate.settings.remove', { name: label(v) })} icon={<X />} onClick={() => remove(v)} />
            </li>
          ))}
        </ul>
      )}
    </Row>
  )

  return (
    <Section title={t('translate.settings.section')}>
      <Card>
        <Row anchor="translate-offer" title={t('translate.settings.offer')} description={t('translate.settings.offer.description')}>
          <Switch aria-label={t('translate.settings.offer')} checked={prefs.offer} onChange={(offer) => save({ offer })} />
        </Row>
        <Row anchor="translate-target" title={t('translate.settings.target')} description={t('translate.settings.target.description')}>
          <Select aria-label={t('translate.settings.target')} size="sm" value={prefs.target ?? AUTO} options={choices} onChange={(v) => save({ target: v === AUTO ? null : v })} />
        </Row>
        <Row anchor="translate-companion" title={t('translate.settings.companion')} description={t('translate.settings.companion.description')}>
          <Switch aria-label={t('translate.settings.companion')} checked={prefs.companion} onChange={(companion) => save({ companion })} />
        </Row>
        {mac && (
          <Row anchor="translate-on-device" title={t('translate.settings.onDevice')} description={t('translate.settings.onDevice.description')}>
            <Button size="sm" variant="secondary" onClick={() => void call('translate', 'openLanguageDownloads').catch(() => undefined)}>
              {t('translate.action.openDownloads')}
            </Button>
          </Row>
        )}
      </Card>
      <Card>
        {list(t('translate.settings.always'), 'translate-always', prefs.always, name, (v) => save({ always: toggleListed(prefs.always, v, false) }))}
        {list(t('translate.settings.never'), 'translate-never', prefs.never, name, (v) => save({ never: toggleListed(prefs.never, v, false) }))}
        {list(t('translate.settings.neverSites'), 'translate-never-sites', prefs.neverSites, (v) => v, (v) => save({ neverSites: toggleListed(prefs.neverSites, v, false) }))}
      </Card>
    </Section>
  )
}
