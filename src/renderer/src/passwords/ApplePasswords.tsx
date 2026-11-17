/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apple Passwords in Apex (macOS): Apple's own iCloud Passwords extension,
// downloaded from the Chrome Web Store, fills from iCloud Keychain. This file
// holds the live status, the Settings section (Settings › Passwords and
// autofill), the note when another password extension handles passwords, and
// the optional offer in the welcome flow. Main owns the status; every state
// here is one main observed.
import { useState, type ReactElement } from 'react'
import { CircleCheck, KeyRound, RefreshCw } from 'lucide-react'
import type { ApplePasswordsState, ApplePasswordsStatus } from '@shared/applePasswords'
import { call, errorText } from '../api'
import { useEvent, useResource, type Resource } from '../settings/data'
import { Card, Row, Section, SwitchRow } from '../settings/kit'
import { Badge, Button, isMac, useToast } from '../ui'
import { useT, type MessageKey, type T } from '../i18n/useT'
import './passwords.css'

/** The status from main, kept live by the apple-passwords event. Loaded on every platform: otherController applies everywhere. */
export function useApplePasswords(): Resource<ApplePasswordsStatus> {
  const res = useResource(() => call('applePasswords', 'status'))
  useEvent('apple-passwords', (e) => res.set(e.status))
  return res
}

const STATE_KEY: Record<Exclude<ApplePasswordsState, 'unavailable'>, MessageKey> = {
  'helper-missing': 'passwords.apple.state.helperMissing',
  off: 'passwords.apple.state.off',
  installing: 'passwords.apple.state.installing',
  starting: 'passwords.apple.state.starting',
  'not-paired': 'passwords.apple.state.notPaired',
  'waiting-for-code': 'passwords.apple.state.waitingForCode',
  ready: 'passwords.apple.state.ready',
  'helper-closed': 'passwords.apple.state.helperClosed',
  'icloud-off': 'passwords.apple.state.icloudOff',
  'needs-signed-apex': 'passwords.apple.state.needsSignedApex',
}

/** The welcome card's short words once Apple Passwords is on. */
const WELCOME_KEY: Record<Exclude<ApplePasswordsState, 'unavailable' | 'helper-missing' | 'off'>, MessageKey> = {
  installing: 'passwords.apple.welcome.installing',
  starting: 'passwords.apple.welcome.starting',
  'not-paired': 'passwords.apple.welcome.notPaired',
  'waiting-for-code': 'passwords.apple.welcome.waitingForCode',
  ready: 'passwords.apple.welcome.ready',
  'helper-closed': 'passwords.apple.welcome.problem',
  'icloud-off': 'passwords.apple.welcome.problem',
  'needs-signed-apex': 'passwords.apple.welcome.problem',
}

function statusWords(t: T, s: ApplePasswordsStatus): string {
  if (s.state === 'unavailable') return ''
  if (s.state === 'helper-closed' && s.error) return t('passwords.apple.state.helperClosedError', { error: s.error })
  return t(STATE_KEY[s.state])
}

/** Runs setOn or pairAgain, takes the status it returns, and shows a failure as a toast. */
function useAppleAction(apple: Resource<ApplePasswordsStatus>): { busy: boolean; run(action: () => Promise<ApplePasswordsStatus>): Promise<void> } {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<ApplePasswordsStatus>): Promise<void> => {
    setBusy(true)
    try {
      apple.set(await action())
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

interface YieldProps {
  apple: Resource<ApplePasswordsStatus>
  /** settings.autofill.yieldToPasswordExtension */
  yieldOn: boolean
  onYield(on: boolean): void
}

/** Settings › Passwords and autofill › Apple Passwords (macOS only; hidden when unavailable). */
export function ApplePasswordsSection({ apple, yieldOn, onYield }: YieldProps): ReactElement | null {
  const t = useT()
  const action = useAppleAction(apple)
  const [turning, setTurning] = useState<boolean | null>(null)
  const s = apple.data
  if (!isMac || !s || s.state === 'unavailable') return null
  const installing = s.state === 'installing'
  const setOn = (on: boolean): void => {
    setTurning(on)
    void action.run(() => call('applePasswords', 'setOn', on)).finally(() => setTurning(null))
  }
  const badge =
    s.state === 'ready' ? (
      <Badge tone="success">{t('passwords.apple.badge.ready')}</Badge>
    ) : s.state === 'waiting-for-code' ? (
      <Badge tone="info">{t('passwords.apple.badge.waiting')}</Badge>
    ) : null
  const pairAgain = s.enabled ? (
    <Button icon={<RefreshCw />} disabled={action.busy} onClick={() => void action.run(() => call('applePasswords', 'pairAgain'))}>
      {t('passwords.apple.pairAgain')}
    </Button>
  ) : null
  return (
    <Section title={t('passwords.apple.section')}>
      <Card className="pw-card">
        <SwitchRow
          anchor="passwords-apple"
          label={t('passwords.apple.switch')}
          description={t('passwords.apple.switchBody')}
          checked={turning ?? (s.enabled || installing)}
          disabled={action.busy || installing || (s.state === 'helper-missing' && !s.installed)}
          onChange={setOn}
        />
        <Row title={t('passwords.apple.statusTitle')} description={<span role="status">{statusWords(t, s)}</span>}>
          {(badge || pairAgain) && (
            <>
              {badge}
              {pairAgain}
            </>
          )}
        </Row>
        {s.enabled && (
          <SwitchRow
            anchor="passwords-apple-yield"
            label={t('passwords.apple.yield')}
            description={s.apexStepsAside ? `${t('passwords.apple.yieldBody')} ${t('passwords.apple.yieldNow')}` : t('passwords.apple.yieldBody')}
            checked={yieldOn}
            onChange={onYield}
          />
        )}
      </Card>
    </Section>
  )
}

/**
 * Rows for the password autofill card when another password extension
 * (not Apple's) handles passwords: a muted note, and the same yield switch
 * when Apple Passwords' own section doesn't already show it.
 */
export function PasswordExtensionNote({ apple, yieldOn, onYield }: YieldProps): ReactElement | null {
  const t = useT()
  const s = apple.data
  const name = s?.otherController
  if (!s || !name) return null
  return (
    <>
      <div className="pw-note">
        <Row title={t('passwords.apple.other.title', { name })} description={t(s.apexStepsAside ? 'passwords.apple.other.stepsAside' : 'passwords.apple.other.both')} />
      </div>
      {!(isMac && s.enabled) && (
        <SwitchRow
          anchor="passwords-apple-yield"
          label={t('passwords.apple.other.yield', { name })}
          description={t('passwords.apple.other.yieldBody', { name })}
          checked={yieldOn}
          onChange={onYield}
        />
      )}
    </>
  )
}

/** The welcome flow's optional offer under the Passwords app import (macOS, when Apple's helper is there). */
export function WelcomeApplePasswords(): ReactElement | null {
  const t = useT()
  const apple = useApplePasswords()
  const action = useAppleAction(apple)
  const s = apple.data
  if (!isMac || !s || s.state === 'unavailable' || s.state === 'helper-missing') return null
  return (
    <div className="pw-welcome">
      <div className="pw-welcome__text">
        <p className="pw-welcome__title">{t('passwords.apple.welcome.title')}</p>
        <p className="pw-welcome__body">{t('passwords.apple.welcome.body')}</p>
      </div>
      {s.state === 'off' ? (
        <Button icon={<KeyRound />} disabled={action.busy} onClick={() => void action.run(() => call('applePasswords', 'setOn', true))}>
          {t('passwords.apple.welcome.button')}
        </Button>
      ) : (
        <span className="pw-welcome__body pw-welcome__status" role="status">
          {s.state === 'ready' && <CircleCheck size={14} aria-hidden />} {t(WELCOME_KEY[s.state])}
        </span>
      )}
    </div>
  )
}
