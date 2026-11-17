/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { ExternalLink, ShieldAlert } from 'lucide-react'
import type { PermissionPromptAnswer, PermissionPromptDismissal, PermissionPromptProps } from '@shared/overlay/sites'
import { call } from '../../../api'
import { useT } from '../../../i18n/useT'
import { Button } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { askPhrase, rememberApplies, rememberLabel } from './logic'
import { PermIcon, useSiteRequest } from './parts'
import { macosNouns, promptKeyAction, promptOrigin } from './promptLogic'
import { useInputGuard } from './useInputGuard'

// The permission prompt (OV-11): under the pill's site-info button,
// tied to the tab that asked. It names the asking origin plainly
// (scheme when not https, port when not the default, "Not secure" on http)
// and what it wants, or the app a link would open. Nothing in it is focused
// to start with and no key allows: a page can't time it under a click or a
// key, and its answers ignore presses for a moment each time it shows. Esc
// puts it away undecided (a dismissal, not a refusal). Where the policy
// allows, a checkbox keeps the answer for the site.

export function PermissionPrompt({ props, resolve, close, shown }: SurfaceComponentProps<PermissionPromptProps>): ReactElement {
  const t = useT()
  const titleId = useId()
  const card = useRef<HTMLDivElement>(null)
  const [remember, setRemember] = useState(false)
  const armed = useInputGuard(shown)
  useSiteRequest(props.requestId, { onClosed: close })

  // Each time it shows, focus sits on the card itself, never on an answer.
  useEffect(() => {
    if (shown !== false) card.current?.focus({ preventScroll: true })
  }, [shown])

  const answer = (allow: boolean): void => {
    if (!armed()) return
    const value: PermissionPromptAnswer = { allow, remember: remember && rememberApplies(props.remember, allow) }
    resolve(value)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (promptKeyAction(e.key) !== 'dismiss') return
    // Handled here, so the host's own Esc (a plain close) stands aside.
    e.preventDefault()
    const value: PermissionPromptDismissal = { dismissed: true }
    resolve(value)
  }

  const blocked = props.systemBlocked.length > 0
  const app = props.perms[0] === 'external-app'
  const label = rememberLabel(props)
  const what = macosNouns(props.systemBlocked)
    .map((key) => t(key))
    .reduce((a, b) => (a ? t('sites.and', { a, b }) : b), '')
  const asker = promptOrigin(props.origin || props.host)

  return (
    <div ref={card} className="st-card st-prompt" role="alertdialog" aria-labelledby={titleId} aria-describedby={`${titleId}-body`} tabIndex={-1} data-autofocus onKeyDown={onKeyDown}>
      <div className="st-prompt__head">
        <span className="st-prompt__glyph" aria-hidden>
          {app ? <ExternalLink size={16} /> : props.perms.length === 1 ? <PermIcon perm={props.perms[0]!} /> : <PermIcon perm="camera" />}
        </span>
        <div className="st-prompt__text">
          {app ? (
            <>
              <h2 id={titleId} className="st-prompt__title">
                {t('sites.prompt.appTitle', { app: props.app ?? t('sites.prompt.appUnknown') })}
              </h2>
              <p id={`${titleId}-body`} className="st-prompt__body">
                {asker.notSecure && <span className="st-prompt__insecure">{t('sites.prompt.notSecure')}</span>}
                {t('sites.prompt.appBody', { host: asker.text, scheme: props.scheme ?? '', app: props.app ?? t('sites.prompt.appUnknown') })}
              </p>
            </>
          ) : (
            <>
              <h2 id={titleId} className="st-prompt__title st-host">
                {asker.notSecure && <span className="st-prompt__insecure">{t('sites.prompt.notSecure')}</span>}
                <span className="st-prompt__origin">{asker.text}</span>
              </h2>
              <ul id={`${titleId}-body`} className="st-prompt__asks" aria-label={t('sites.prompt.label', { host: asker.text })}>
                {askPhrase(props.perms).map(([key, vars]) => (
                  <li key={key}>{t('sites.prompt.wants', { what: t(key, vars) })}</li>
                ))}
              </ul>
              {props.embedded && <p className="st-prompt__embedded">{t('sites.prompt.embedded', { host: props.embedded })}</p>}
            </>
          )}
        </div>
      </div>

      {blocked ? (
        <div className="st-prompt__system" role="note">
          <ShieldAlert size={14} aria-hidden />
          <p>{t('sites.prompt.systemBlocked', { what })}</p>
        </div>
      ) : (
        label && (
          <label className="st-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>{t(label[0], label[1])}</span>
          </label>
        )
      )}

      <div className="st-actions">
        {blocked ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => answer(false)}>
              {t('sites.prompt.close')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                if (!armed()) return
                void call('sites', 'openSystemSettings', props.systemBlocked[0] ?? 'camera')
                answer(false)
              }}
            >
              {t('sites.prompt.openSystem')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={() => answer(false)}>
              {t('sites.prompt.deny')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => answer(true)}>
              {app ? t('sites.prompt.open') : t('sites.prompt.allow')}
            </Button>
          </>
        )}
      </div>
      <p className="st-hint" aria-hidden>
        {t('sites.prompt.keys')}
      </p>
    </div>
  )
}
