/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, type ReactElement } from 'react'
import { Bell, ShieldAlert } from 'lucide-react'
import type { PermissionChipAnswer, PermissionChipProps } from '@shared/overlay/sites'
import { useT } from '../../../i18n/useT'
import { Button } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { macosNouns, macosPane, promptOrigin } from './promptLogic'
import { useInputGuard } from './useInputGuard'

// The popover under an address bar permission chip. A quiet notification
// request (held back so it wouldn't interrupt) is answered here with Allow or
// Don't allow; a permission macOS has turned off for Apex says so and offers
// the System Settings pane and a reload. It resolves with what the person
// chose; the chip in the chrome acts on it. Like the prompt, nothing is
// focused to start with and the answers wait out the input delay.

export function PermissionChipPopover({ props, resolve, shown }: SurfaceComponentProps<PermissionChipProps>): ReactElement {
  const t = useT()
  const titleId = useId()
  const armed = useInputGuard(shown)
  const asker = promptOrigin(props.origin)
  const act = (action: PermissionChipAnswer['action']): void => {
    if (!armed()) return
    const value: PermissionChipAnswer = { action }
    resolve(value)
  }

  if (props.kind === 'quiet') {
    return (
      <div className="st-card st-prompt" role="dialog" aria-labelledby={titleId} aria-describedby={`${titleId}-body`} tabIndex={-1} data-autofocus>
        <div className="st-prompt__head">
          <span className="st-prompt__glyph" aria-hidden>
            <Bell size={16} />
          </span>
          <div className="st-prompt__text">
            <h2 id={titleId} className="st-prompt__title st-host">
              {asker.notSecure && <span className="st-prompt__insecure">{t('sites.prompt.notSecure')}</span>}
              <span className="st-prompt__origin">{asker.text}</span>
            </h2>
            <div id={`${titleId}-body`}>
              <p className="st-prompt__body">{t('sites.prompt.wants', { what: t('sites.ask.notifications') })}</p>
              <p className="st-prompt__body st-small">{t('sites.chip.quietBody')}</p>
            </div>
          </div>
        </div>
        <div className="st-actions">
          <Button variant="secondary" size="sm" onClick={() => act('block')}>
            {t('sites.prompt.deny')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => act('allow')}>
            {t('sites.prompt.allow')}
          </Button>
        </div>
      </div>
    )
  }

  const nouns = macosNouns(props.perms).map((key) => t(key))
  const what = nouns.reduce((a, b) => (a ? t('sites.and', { a, b }) : b), '')
  const pane = macosPane(props.perms)
  return (
    <div className="st-card st-prompt" role="dialog" aria-labelledby={titleId} aria-describedby={`${titleId}-body`} tabIndex={-1} data-autofocus>
      <div className="st-prompt__head">
        <span className="st-prompt__glyph st-prompt__glyph--warning" aria-hidden>
          <ShieldAlert size={16} />
        </span>
        <div className="st-prompt__text">
          <h2 id={titleId} className="st-prompt__title">
            {t('sites.chip.macosTitle', { what })}
          </h2>
          <p id={`${titleId}-body`} className="st-prompt__body">
            {t('sites.chip.macosBody', { host: asker.text })}
          </p>
        </div>
      </div>
      <div className="st-actions">
        <Button variant="secondary" size="sm" onClick={() => act('reload')}>
          {t('sites.chip.reload')}
        </Button>
        {pane && (
          <Button variant="primary" size="sm" onClick={() => act('open-settings')}>
            {t('sites.prompt.openSystem')}
          </Button>
        )}
      </div>
    </div>
  )
}
