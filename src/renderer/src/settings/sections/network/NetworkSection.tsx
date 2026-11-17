/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useState, type ReactElement } from 'react'
import type { ProxyMode, ProxySettings } from '@shared/ipc'
import { validateProxy, type ProxyField } from '@shared/proxy'
import { errorText } from '../../../api'
import { useT } from '../../../i18n/useT'
import { Button, Select, useToast } from '../../../ui'
import { Card, Field, Row, Section, TextArea, TextInput } from '../../kit'
import type { SettingsPageProps } from '../../pageTypes'
import { FIELD_HINT, FIELD_LABEL, MODE_LABEL, PROXY_MODES, appliesAtOnce, fieldIssueMessage, proxyDirty, proxyFields } from './logic'

// Settings › General's network section: the proxy every
// session uses. System and No proxy apply when picked; Manual and PAC keep
// a draft, checked field by field, until Apply. A proxy that asks for a
// password goes through the sign-in dialog the first time it is needed.

export function NetworkSection({ settings, update }: SettingsPageProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const base = useId()
  const applied = settings.proxy
  const [draft, setDraft] = useState<ProxySettings>(applied)
  const [touched, setTouched] = useState<Partial<Record<ProxyField, boolean>>>({})
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)

  // Another window (or a reset) changed the settings: start over from them.
  const appliedKey = JSON.stringify(applied)
  useEffect(() => {
    setDraft(applied)
    setTouched({})
    setTried(false)
    // appliedKey stands for applied's contents.
  }, [appliedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const errors = validateProxy(draft)
  const fields = proxyFields(draft.mode)
  const dirty = proxyDirty(draft, applied)
  const valid = fields.every((f) => !errors[f])

  const apply = async (next: ProxySettings): Promise<void> => {
    setBusy(true)
    try {
      await update({ proxy: next })
      toast.show({ tone: 'success', message: t('safety.proxy.applied') })
    } catch (err) {
      toast.show({ tone: 'error', message: t('safety.privacy.saveFailed', { message: errorText(err) }) })
    } finally {
      setBusy(false)
    }
  }

  const pickMode = (mode: ProxyMode): void => {
    const next = { ...draft, mode }
    setDraft(next)
    setTried(false)
    if (appliesAtOnce(mode) && mode !== applied.mode) void apply(next)
  }

  const onApply = (): void => {
    setTried(true)
    if (!valid) {
      // Focus the first field with a problem, so a keyboard user lands on it.
      const first = fields.find((f) => errors[f])
      if (first) document.getElementById(`${base}-${first}`)?.focus()
      return
    }
    void apply(draft)
  }

  return (
    <Section title={t('safety.proxy.title')} note={draft.mode === 'manual' || draft.mode === 'pac' ? t('safety.proxy.signIn') : undefined}>
      <Card>
        <Row anchor="proxy" title={t('safety.proxy.mode')} description={t('safety.proxy.modeBody')} htmlFor={`${base}-mode`}>
          <Select
            id={`${base}-mode`}
            size="sm"
            value={draft.mode}
            disabled={busy}
            options={PROXY_MODES.map((m) => ({ value: m, label: t(MODE_LABEL[m]) }))}
            onChange={pickMode}
          />
        </Row>
        {fields.length > 0 && (
          <div className="sp-row sp-row--stack">
            <form
              className="net-proxy"
              noValidate
              onSubmit={(e) => {
                e.preventDefault()
                onApply()
              }}
            >
              {fields.map((f) => {
                const id = `${base}-${f}`
                const issue = touched[f] || tried ? errors[f] : undefined
                const message = issue ? t(fieldIssueMessage(f, issue)) : null
                const common = {
                  id,
                  value: draft[f],
                  invalid: !!issue,
                  spellCheck: false,
                  autoCapitalize: 'off',
                  autoCorrect: 'off',
                  disabled: busy,
                  onBlur: () => setTouched((x) => ({ ...x, [f]: true })),
                }
                return (
                  <Field key={f} label={t(FIELD_LABEL[f])} hint={t(FIELD_HINT[f])} error={message} htmlFor={id}>
                    {f === 'bypass' ? (
                      <TextArea {...common} rows={2} code onChange={(e) => setDraft((d) => ({ ...d, bypass: e.target.value }))} />
                    ) : (
                      <TextInput {...common} type={f === 'pacUrl' ? 'url' : 'text'} onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))} />
                    )}
                  </Field>
                )
              })}
              <div className="net-proxy__actions">
                <Button size="sm" variant="ghost" disabled={!dirty || busy} onClick={() => {
                  setDraft(applied)
                  setTouched({})
                  setTried(false)
                }}>
                  {t('safety.proxy.revert')}
                </Button>
                <Button size="sm" variant="primary" type="submit" disabled={!dirty} loading={busy}>
                  {busy ? t('safety.proxy.applying') : t('safety.proxy.apply')}
                </Button>
              </div>
            </form>
          </div>
        )}
      </Card>
    </Section>
  )
}
