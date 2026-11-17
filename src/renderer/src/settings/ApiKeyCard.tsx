/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Anthropic API key: status, entry and removal. The full card lives in
// Model and key; the You page shows the status and the entry while none is set.
import { useState, type ReactElement } from 'react'
import { ExternalLink } from 'lucide-react'
import type { SettingsView } from '@shared/ipc'
import { apex, errorText } from '../api'
import { Badge, Button, useConfirm, useToast } from '../ui'
import { Card, Row, TextInput } from './kit'
import { useT, t } from '../i18n/useT'

const CONSOLE_KEYS_URL = 'https://console.anthropic.com/settings/keys'

export function keyStatus(settings: SettingsView): { tone: 'success' | 'info' | 'warning'; label: string; detail: string } {
  if (settings.apiKeySource === 'saved') return { tone: 'success', label: t('settings.apiKeyCard.saved'), detail: t('settings.apiKeyCard.encryptedWithYourSystem') }
  if (settings.apiKeySource === 'environment') return { tone: 'info', label: t('settings.apiKeyCard.fromEnvironment'), detail: t('settings.apiKeyCard.apexIsUsingAnthropic') }
  return { tone: 'warning', label: t('settings.apiKeyCard.notSet'), detail: t('settings.apiKeyCard.yourCompanionNeedsA') }
}

export function ApiKeyCard({ settings, onSettings, variant = 'full', onManage }: { settings: SettingsView; onSettings(view: SettingsView): void; variant?: 'full' | 'summary'; onManage?(): void }): ReactElement {
  const t = useT()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = useConfirm()
  const toast = useToast()
  const status = keyStatus(settings)

  const save = async (value: string | null): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onSettings(await apex.settings.setApiKey(value))
      setKey('')
      toast.show({ tone: 'success', message: value ? t('settings.apiKeyCard.apiKeySaved') : t('settings.apiKeyCard.savedApiKeyRemoved') })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('settings.apiKeyCard.removeTheSavedKey'),
      message: settings.hasApiKey ? t('settings.apiKeyCard.newMessagesWillFail') : undefined,
      confirmLabel: t('settings.apiKeyCard.removeKey'),
      destructive: true,
    })
    if (ok) await save(null)
  }

  const showEntry = variant === 'full' || settings.apiKeySource === 'none'
  return (
    <Card>
      <Row title={t('settings.apiKeyCard.anthropicApiKey')} description={status.detail}>
        <Badge tone={status.tone}>{status.label}</Badge>
        {variant === 'summary' && onManage && (
          <Button size="sm" variant="ghost" onClick={onManage}>
            {t('settings.apiKeyCard.modelAndKey')}
          </Button>
        )}
      </Row>
      {showEntry && (
        <form
          className="sp-row sp-row--stack"
          onSubmit={(e) => {
            e.preventDefault()
            if (key.trim()) void save(key.trim())
          }}
        >
          <div className="sp-field__row">
            <TextInput
              className="sp-input--inline"
              type="password"
              value={key}
              placeholder={settings.apiKeySource === 'saved' ? t('settings.apiKeyCard.pasteANewKey') : 'sk-ant-…'}
              autoComplete="off"
              spellCheck={false}
              aria-label={t('settings.apiKeyCard.apiKey')}
              invalid={!!error}
              onChange={(e) => setKey(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={!key.trim()} loading={busy}>
              {t('settings.apiKeyCard.saveKey')}
            </Button>
            {variant === 'full' && settings.apiKeySource === 'saved' && (
              <Button variant="secondary" disabled={busy} onClick={() => void remove()}>
                {t('settings.apiKeyCard.remove')}
              </Button>
            )}
          </div>
          {error ? (
            <p className="sp-field__error" role="alert">
              {error}
            </p>
          ) : (
            <p className="sp-field__hint">
              {t('settings.apiKeyCard.keysStayOnThis')}{' '}
              <button type="button" className="sp-link" onClick={() => void apex.tabs.create(CONSOLE_KEYS_URL)}>
                {t('settings.apiKeyCard.getAKey')} <ExternalLink size={12} aria-hidden />
              </button>
            </p>
          )}
        </form>
      )}
    </Card>
  )
}
