/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { READER_FONTS, READER_RATES, READER_TEXT_STEPS, READER_THEMES, READER_WIDTHS } from '@shared/readerPrefs'
import { currentLocale } from '@shared/i18n/core'
import { useT } from '../i18n/useT'
import { Kbd, SegmentedControl, Select } from '../ui'
import { Card, Row, Section, SwitchRow } from '../settings/kit'
import { nearestRate } from './logic/view'
import { sortVoices } from './logic/speech'
import { speechAvailable } from './readAloud'

// Settings › Appearance › Reader (RD-05): the reader's defaults, the same
// choices as the reader's own Text and page panel, plus the pill button and
// the read-aloud voice and speed.

function useVoiceList(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  useEffect(() => {
    if (!speechAvailable()) return
    const update = (): void => setVoices(window.speechSynthesis.getVoices())
    update()
    window.speechSynthesis.addEventListener('voiceschanged', update)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', update)
  }, [])
  return voices
}

export function ReaderSettings({ settings, update }: { settings: SettingsView; update(patch: SettingsPatch): Promise<void> }): ReactElement {
  const t = useT()
  const voices = useVoiceList()
  const sorted = useMemo(() => sortVoices(voices, currentLocale()), [voices])
  const [before, after] = t('reader.settings.button.description').split('{keys}')
  const set = (patch: SettingsPatch): void => void update(patch)
  return (
    <Section title={t('reader.settings.title')}>
      <Card>
        <SwitchRow
          anchor="reader-button"
          label={t('reader.settings.button')}
          description={
            <>
              {before}
              <Kbd shortcut="Alt+CmdOrCtrl+R" />
              {after}
            </>
          }
          checked={settings.readerButton}
          onChange={(readerButton) => set({ readerButton })}
        />
        <Row anchor="reader-font" title={t('reader.font.label')} description={t('reader.settings.font.description')}>
          <SegmentedControl
            label={t('reader.font.label')}
            size="sm"
            options={READER_FONTS.map((f) => ({ value: f, label: t(f === 'serif' ? 'reader.font.serif' : 'reader.font.sans') }))}
            value={settings.readerFont}
            onChange={(readerFont) => set({ readerFont })}
          />
        </Row>
        <Row anchor="reader-size" title={t('reader.size.label')} description={t('reader.settings.size.description')} htmlFor="settings-reader-size">
          <Select
            id="settings-reader-size"
            size="sm"
            value={String(settings.readerTextSize)}
            options={[...new Set<number>([...READER_TEXT_STEPS, settings.readerTextSize])].sort((a, b) => a - b).map((s) => ({ value: String(s), label: t('reader.size.value', { size: s }) }))}
            onChange={(s) => set({ readerTextSize: Number(s) })}
          />
        </Row>
        <Row anchor="reader-width" title={t('reader.width.label')} description={t('reader.settings.width.description')}>
          <SegmentedControl
            label={t('reader.width.label')}
            size="sm"
            options={READER_WIDTHS.map((w) => ({ value: w, label: t(w === 'narrow' ? 'reader.width.narrow' : w === 'wide' ? 'reader.width.wide' : 'reader.width.medium') }))}
            value={settings.readerWidth}
            onChange={(readerWidth) => set({ readerWidth })}
          />
        </Row>
        <Row anchor="reader-theme" title={t('reader.theme.label')} description={t('reader.settings.theme.description')}>
          <SegmentedControl
            label={t('reader.theme.label')}
            size="sm"
            options={READER_THEMES.map((theme) => ({
              value: theme,
              label: t(theme === 'auto' ? 'reader.theme.auto' : theme === 'light' ? 'reader.theme.light' : theme === 'sepia' ? 'reader.theme.sepia' : 'reader.theme.dark'),
            }))}
            value={settings.readerTheme}
            onChange={(readerTheme) => set({ readerTheme })}
          />
        </Row>
        <Row anchor="reader-voice" title={t('reader.view.voice')} description={t('reader.settings.voice.description')} htmlFor="settings-reader-voice">
          <Select
            id="settings-reader-voice"
            size="sm"
            value={settings.readerVoice ?? ''}
            options={[{ value: '', label: t('reader.view.voiceAuto') }, ...sorted.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` }))]}
            onChange={(uri) => set({ readerVoice: uri || null })}
          />
        </Row>
        <Row anchor="reader-rate" title={t('reader.settings.rate')} description={t('reader.settings.rate.description')} htmlFor="settings-reader-rate">
          <Select
            id="settings-reader-rate"
            size="sm"
            value={String(nearestRate(settings.readerRate))}
            options={READER_RATES.map((r) => ({ value: String(r), label: t('reader.view.speedValue', { rate: r }) }))}
            onChange={(r) => set({ readerRate: Number(r) })}
          />
        </Row>
      </Card>
    </Section>
  )
}
