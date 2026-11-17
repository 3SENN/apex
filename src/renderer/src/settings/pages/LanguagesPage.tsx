/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Languages (ST-32): follow the system, or an ordered list of up
// to ten for websites and spellcheck. Edits stay local until Save, which is
// enabled only after a change; main applies the list live to every session.
// Apex's own language sits on top (AppLanguageCard), and languages are
// named in the app language rather than Chromium's.
import { useEffect, useId, useMemo, useState, type ReactElement } from 'react'
import { ArrowDown, ArrowUp, Languages, X } from 'lucide-react'
import { addLanguage, languagesChanged, LANGUAGES_MAX, moveLanguage, removeLanguage, searchLanguages } from '@shared/languages'
import { call } from '../../api'
import { useLanguage, useT } from '../../i18n/useT'
import { AppLanguageCard } from '../../i18n/AppLanguageCard'
import { Button, EmptyState, IconButton, SegmentedControl, useAsyncAction } from '../../ui'
import { useResource } from '../data'
import { Card, PageHeader, Row, Section, TextInput } from '../kit'
import type { SettingsPageProps } from '../pageTypes'
import { TranslateSection } from '../../translate/TranslateSettings' // translate (TR-12)

function displayNames(locale: string): (tag: string) => string {
  let names: Intl.DisplayNames | null = null
  try {
    names = new Intl.DisplayNames([locale, 'en'], { type: 'language' })
  } catch {
    names = null
  }
  return (tag) => {
    try {
      return names?.of(tag) ?? tag
    } catch {
      return tag
    }
  }
}

export function LanguagesPage({ settings, update }: SettingsPageProps): ReactElement {
  const t = useT()
  const { locale } = useLanguage()
  const name = useMemo(() => displayNames(locale), [locale])
  const [draft, setDraft] = useState<string[]>(settings.languages.list)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const listId = useId()
  const saved = settings.languages.list
  // A save elsewhere (another window) refreshes an untouched draft.
  useEffect(() => {
    setDraft((current) => (languagesChanged(current, saved) ? current : saved))
  }, [saved.join(',')])

  const changed = languagesChanged(draft, saved)
  const save = useAsyncAction(() => update({ languages: { mode: 'custom', list: draft } }), { success: t('settings.languages.saved') })
  const suggestions = searchLanguages(query, draft, name)
  const join = (list: readonly string[]): string => list.map(name).join(', ')
  // The system's own order comes from main; the chrome's navigator only knows Apex's locale.
  const about = useResource(() => call('about', 'info'))
  const system = about.data?.systemLanguages.length ? about.data.systemLanguages : [...navigator.languages]

  const add = (input: string): void => {
    const result = addLanguage(draft, input)
    if (result.error) {
      setError(result.error === 'full' ? t('settings.languages.error.full', { max: LANGUAGES_MAX }) : result.error === 'duplicate' ? t('settings.languages.error.duplicate') : t('settings.languages.error.invalid'))
      return
    }
    setDraft(result.list)
    setQuery('')
    setError(null)
    setActive(0)
  }

  return (
    <>
      <PageHeader title={t('settings.languages.title')} description={t('settings.languages.description')} />
      {/* The app language card. */}
      <AppLanguageCard settings={settings} update={update} />
      <Section title={t('settings.languages.source')}>
        <Card>
          <Row anchor="languages-mode" title={t('settings.languages.mode')} description={settings.languages.mode === 'system' ? t('settings.languages.system', { list: join(system) }) : t('settings.languages.mode.description')}>
            <SegmentedControl
              label={t('settings.languages.mode')}
              size="sm"
              options={[
                { value: 'system', label: t('settings.languages.mode.system') },
                { value: 'custom', label: t('settings.languages.mode.custom') },
              ]}
              value={settings.languages.mode}
              onChange={(mode) => void update({ languages: { mode, list: mode === 'custom' && saved.length === 0 ? system.slice(0, LANGUAGES_MAX).filter((tag) => addLanguage([], tag).error === null) : saved } })}
            />
          </Row>
        </Card>
      </Section>
      {settings.languages.mode === 'custom' && (
        <Section title={t('settings.languages.list')} note={t('settings.languages.list.note', { max: LANGUAGES_MAX })}>
          <Card>
            {draft.length === 0 ? (
              <EmptyState compact icon={<Languages />} title={t('settings.languages.empty')} description={t('settings.languages.empty.description')} />
            ) : (
              <ol className="sp-lang-list" aria-label={t('settings.languages.list')}>
                {draft.map((tag, i) => (
                  <li key={tag} className="sp-lang">
                    <span className="sp-lang__index" aria-hidden>
                      {i + 1}
                    </span>
                    <span className="sp-lang__name">
                      {name(tag)}
                      <span className="sp-lang__tag">{tag}</span>
                    </span>
                    {i === 0 && <span className="sp-lang__first">{t('settings.languages.first')}</span>}
                    <span className="sp-lang__actions">
                      <IconButton size="sm" label={t('settings.languages.moveUp', { name: name(tag) })} icon={<ArrowUp />} disabled={i === 0} onClick={() => setDraft(moveLanguage(draft, i, -1))} />
                      <IconButton size="sm" label={t('settings.languages.moveDown', { name: name(tag) })} icon={<ArrowDown />} disabled={i === draft.length - 1} onClick={() => setDraft(moveLanguage(draft, i, 1))} />
                      <IconButton size="sm" label={t('settings.languages.remove', { name: name(tag) })} icon={<X />} onClick={() => setDraft(removeLanguage(draft, i))} />
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <div className="sp-lang-add" data-settings-anchor="languages-add">
              <label className="sp-row__title" htmlFor={`${listId}-input`}>
                {t('settings.languages.add')}
              </label>
              <div className="sp-lang-add__field">
                <TextInput
                  id={`${listId}-input`}
                  role="combobox"
                  aria-expanded={suggestions.length > 0}
                  aria-controls={`${listId}-list`}
                  aria-activedescendant={suggestions.length > 0 ? `${listId}-opt-${active}` : undefined}
                  aria-invalid={error !== null}
                  aria-describedby={error ? `${listId}-error` : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  placeholder={t('settings.languages.add.placeholder')}
                  disabled={draft.length >= LANGUAGES_MAX}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setActive(0)
                    setError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' && suggestions.length) {
                      e.preventDefault()
                      setActive((a) => Math.min(suggestions.length - 1, a + 1))
                    } else if (e.key === 'ArrowUp' && suggestions.length) {
                      e.preventDefault()
                      setActive((a) => Math.max(0, a - 1))
                    } else if (e.key === 'Enter') {
                      e.preventDefault()
                      add(suggestions[active] ?? query)
                    } else if (e.key === 'Escape' && query) {
                      e.preventDefault()
                      setQuery('')
                    }
                  }}
                />
                <Button size="sm" disabled={!query.trim() || draft.length >= LANGUAGES_MAX} onClick={() => add(suggestions[active] ?? query)}>
                  {t('settings.languages.add.button')}
                </Button>
              </div>
              {suggestions.length > 0 && (
                <ul id={`${listId}-list`} role="listbox" className="sp-lang-suggest" aria-label={t('settings.languages.add')}>
                  {suggestions.map((tag, i) => (
                    <li
                      key={tag}
                      id={`${listId}-opt-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className="sp-lang-suggest__item"
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => add(tag)}
                    >
                      {name(tag)}
                      <span className="sp-lang__tag">{tag}</span>
                    </li>
                  ))}
                </ul>
              )}
              {error && (
                <p id={`${listId}-error`} className="sp-field__error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="sp-lang-save">
              <p className="sp-row__description" aria-live="polite">
                {draft.length > 0 ? t('settings.languages.summary', { list: join(draft) }) : null}
              </p>
              {save.error && (
                <p className="sp-field__error" role="alert">
                  {save.error}
                </p>
              )}
              <Button size="sm" variant="ghost" disabled={!changed || save.busy} onClick={() => setDraft(saved)}>
                {t('settings.languages.revert')}
              </Button>
              <Button size="sm" variant="primary" disabled={!changed || draft.length === 0} loading={save.busy} onClick={() => void save.run()}>
                {t('settings.languages.save')}
              </Button>
            </div>
          </Card>
        </Section>
      )}
      {/* translate (TR-12): offer, target, companion engine, the always and never lists */}
      <TranslateSection settings={settings} update={update} />
    </>
  )
}
