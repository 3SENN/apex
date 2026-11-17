/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Search (ST-31): the search engine catalogue with each
// engine's drawn initial (no favicon is fetched, so opening Settings
// contacts no search site), the current one marked, a confirmation before
// switching, custom engines (a name and an https address with %s for the
// words), and the search-suggestions switch.
// Changes apply live; main re-reads custom engines as settings change.
import { useId, useState, type FormEvent, type ReactElement } from 'react'
import { Check, Search, X } from 'lucide-react'
import type { CustomSearchEngine } from '@shared/ipc'
import { BUILT_IN_SEARCH_ENGINES, CUSTOM_ENGINES_MAX, CUSTOM_ENGINE_NAME_MAX, CUSTOM_ENGINE_TEMPLATE_MAX, validateCustomEngine, type SearchEngineDef, type TemplateProblem } from '@shared/searchEngines'
import { errorText } from '../../api'
import { useT, type MessageKey } from '../../i18n/useT'
import { Button, IconButton, cx, useConfirm, useToast } from '../../ui'
import { Card, Field, PageHeader, Row, Section, SwitchRow, TextInput } from '../kit'
import type { SettingsPageProps } from '../pageTypes'

const PROBLEM_KEYS: Record<TemplateProblem, MessageKey> = {
  empty: 'address.search.template.empty',
  invalid: 'address.search.template.invalid',
  https: 'address.search.template.https',
  placeholder: 'address.search.template.placeholder',
}

/**
 * A drawn initial, not the engine's favicon: opening Settings never contacts
 * a search engine (the network guard holds the smoke run to that too).
 */
function EngineIcon({ engine }: { engine: Pick<SearchEngineDef, 'name'> }): ReactElement {
  const initial = engine.name.trim().charAt(0).toUpperCase()
  if (!initial) return <Search size={15} aria-hidden />
  return (
    <span className="se-icon se-icon--initial" aria-hidden="true">
      {initial}
    </span>
  )
}

export function SearchPage({ settings, update }: Pick<SettingsPageProps, 'settings' | 'update'>): ReactElement {
  const t = useT()
  const confirm = useConfirm()
  const toast = useToast()
  const ids = { name: useId(), template: useId() }
  const custom = settings.customSearchEngines
  const engines: SearchEngineDef[] = [...BUILT_IN_SEARCH_ENGINES, ...custom.map((c) => ({ ...c, builtIn: false }))]
  const current = engines.find((e) => e.id === settings.searchEngine) ?? BUILT_IN_SEARCH_ENGINES[0]
  const [name, setName] = useState('')
  const [template, setTemplate] = useState('')
  const [errors, setErrors] = useState<{ name: boolean; problem: TemplateProblem | null } | null>(null)

  const choose = async (engine: SearchEngineDef): Promise<void> => {
    if (engine.id === current?.id) return
    const ok = await confirm({ title: t('address.search.confirm', { engine: engine.name }), message: t('address.search.confirmBody', { engine: engine.name }), confirmLabel: t('address.search.change') })
    if (!ok) return
    try {
      await update({ searchEngine: engine.id })
      toast.show({ tone: 'success', message: t('address.search.changed', { engine: engine.name }) })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const result = validateCustomEngine(name, template, custom)
    if (!('engine' in result)) {
      setErrors({ name: result.nameError, problem: result.problem })
      return
    }
    try {
      await update({ customSearchEngines: [...custom, result.engine] })
      setName('')
      setTemplate('')
      setErrors(null)
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  const remove = async (engine: CustomSearchEngine): Promise<void> => {
    try {
      // Removing the engine in use falls back to the first built-in one.
      await update({ customSearchEngines: custom.filter((c) => c.id !== engine.id), ...(settings.searchEngine === engine.id ? { searchEngine: BUILT_IN_SEARCH_ENGINES[0]?.id ?? 'google' } : {}) })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  return (
    <>
      <PageHeader title={t('address.search.title')} description={t('address.search.engineHint')} />
      <Section title={t('address.search.engine')}>
        <Card>
          <ul className="se-list" aria-label={t('address.search.engine')}>
            {engines.map((engine) => {
              const on = engine.id === current?.id
              return (
                <li key={engine.id} className={cx('se-row', on && 'se-row--on')} data-anchor={engine.id === BUILT_IN_SEARCH_ENGINES[0]?.id ? 'search-engine' : undefined}>
                  <span className="se-row__icon">
                    <EngineIcon engine={engine} />
                  </span>
                  <span className="se-row__name">{engine.name}</span>
                  {on ? (
                    <span className="se-row__current">
                      <Check size={14} aria-hidden />
                      {t('address.search.current')}
                    </span>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => void choose(engine)} aria-label={`${t('address.search.use')} ${engine.name}`}>
                      {t('address.search.use')}
                    </Button>
                  )}
                  {!engine.builtIn && (
                    <IconButton size="sm" label={t('address.search.customRemove', { name: engine.name })} icon={<X />} onClick={() => void remove(engine)} />
                  )}
                </li>
              )
            })}
          </ul>
        </Card>
      </Section>
      <Section title={t('address.search.custom')}>
        <Card>
          {custom.length === 0 && <p className="se-none">{t('address.search.customNone')}</p>}
          <form className="se-add" onSubmit={(e) => void add(e)} noValidate>
            <Field label={t('address.search.customName')} htmlFor={ids.name} error={errors?.name ? t('address.search.customNameMissing') : null}>
              <TextInput id={ids.name} value={name} maxLength={CUSTOM_ENGINE_NAME_MAX} invalid={errors?.name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('address.search.customTemplate')} htmlFor={ids.template} error={errors?.problem ? t(PROBLEM_KEYS[errors.problem]) : null}>
              <TextInput
                id={ids.template}
                value={template}
                maxLength={CUSTOM_ENGINE_TEMPLATE_MAX}
                placeholder="https://example.com/search?q=%s"
                spellCheck={false}
                invalid={!!errors?.problem}
                onChange={(e) => setTemplate(e.target.value)}
              />
            </Field>
            <div className="se-add__actions">
              <Button type="submit" variant="secondary" disabled={custom.length >= CUSTOM_ENGINES_MAX}>
                {t('address.search.customAdd')}
              </Button>
            </div>
          </form>
        </Card>
      </Section>
      <Section title={t('address.search.suggestions')}>
        <Card>
          <Row title={t('address.search.suggestions')} description={t('address.search.suggestionsHint')} anchor="search-suggestions">
            <SwitchRow checked={settings.searchSuggestions} onChange={(searchSuggestions) => void update({ searchSuggestions })} aria-label={t('address.search.suggestions')} />
          </Row>
        </Card>
      </Section>
    </>
  )
}
