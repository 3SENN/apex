/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useMemo, useState, type ReactElement } from 'react'
import type { TranslatePopoverProps } from '@shared/overlay/translate'
import type { TranslateErrorCode } from '@shared/translate'
import { Languages } from 'lucide-react'
import { call } from '../../../api'
import { useLanguage, useT } from '../../../i18n/useT'
import { languageNamer, targetChoices } from '../../../translate/names'
import { Button, CheckRow, Select } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'

// The translate popover (TR-11), under the pill's translate button: what
// language the page is in, Translate to <language> (or Show original), and
// Always translate <language>, Never translate <language> and Never translate
// this site. A failure says why and what helps (download the languages, or
// turn on the companion engine). Its props follow the tab while it is open.

const ERROR_KEYS = {
  'not-installed': 'translate.error.notInstalled',
  unsupported: 'translate.error.unsupported',
  unavailable: 'translate.error.unavailable',
  'companion-unavailable': 'translate.error.companionUnavailable',
  'unknown-language': 'translate.error.unknownLanguage',
  failed: 'translate.error.failed',
} as const satisfies Record<TranslateErrorCode, string>

export function TranslatePopover({ props }: SurfaceComponentProps<TranslatePopoverProps>): ReactElement {
  const t = useT()
  const { locale } = useLanguage()
  const name = useMemo(() => languageNamer(locale), [locale])
  const selectId = useId()
  const s = props.state
  const [target, setTarget] = useState(s.target)
  useEffect(() => setTarget(s.target), [s.target])
  const choices = useMemo(() => targetChoices(name, s.target), [name, s.target])

  const language = name(s.language)
  const targetName = name(target)
  const busy = s.status === 'translating'
  const translated = s.status === 'translated'
  const shown = busy || translated
  const run = (to: string): void => void call('translate', 'translate', props.tabId, to).catch(() => undefined)
  const restore = (): void => void call('translate', 'restore', props.tabId).catch(() => undefined)

  let status: string | null = null
  if (busy) status = s.progress && s.progress.total > 0 ? t('translate.popover.progress', { done: s.progress.done, total: s.progress.total }) : t('translate.popover.translating')
  else if (translated) status = s.engine === 'companion' ? t('translate.engine.companion', { name: props.companion }) : t('translate.engine.apple')

  const error = s.status === 'error' && s.error ? s.error : null
  const offerCompanion = error === 'not-installed' || error === 'unsupported' || error === 'unavailable'

  return (
    <div className="trp" role="group" aria-label={t('translate.popover.label')}>
      <div className="trp__head">
        <span className="trp__glyph" aria-hidden>
          <Languages size={16} />
        </span>
        <span className="trp__title">{translated ? t('translate.popover.translatedFrom', { language }) : t('translate.popover.pageIn', { language })}</span>
      </div>
      <div className="trp__row">
        <label className="trp__label" htmlFor={selectId}>
          {t('translate.popover.to')}
        </label>
        <Select
          id={selectId}
          size="sm"
          value={target}
          options={choices}
          onChange={(value) => {
            setTarget(value)
            // A new language while translated translates again at once.
            if (shown) run(value)
          }}
        />
      </div>
      <div className="trp__actions">
        {shown && (
          <Button size="sm" variant="secondary" onClick={restore}>
            {t('translate.popover.showOriginal')}
          </Button>
        )}
        {!translated && (
          <Button size="sm" variant="primary" loading={busy} onClick={() => run(target)} data-autofocus>
            {error ? t('translate.action.retry') : t('translate.popover.translate')}
          </Button>
        )}
      </div>
      {status && (
        <p className="trp__status" role="status">
          {status}
        </p>
      )}
      {error && (
        <div className="trp__error" role="alert">
          <p>{t(ERROR_KEYS[error], { language, target: targetName, name: props.companion })}</p>
          {offerCompanion && <p className="trp__hint">{t('translate.error.companionHint')}</p>}
          {error === 'not-installed' && (
            <Button size="sm" variant="ghost" onClick={() => void call('translate', 'openLanguageDownloads').catch(() => undefined)}>
              {t('translate.action.openDownloads')}
            </Button>
          )}
        </div>
      )}
      <div className="trp__choices">
        <CheckRow label={t('translate.popover.always', { language })} checked={s.always} onChange={(on) => void call('translate', 'setAlways', props.tabId, on).catch(() => undefined)} />
        <CheckRow label={t('translate.popover.neverLanguage', { language })} checked={false} onChange={(on) => void call('translate', 'setNeverLanguage', props.tabId, on).catch(() => undefined)} />
        {s.host && <CheckRow label={t('translate.popover.neverSite')} checked={s.neverSite} onChange={(on) => void call('translate', 'setNeverSite', props.tabId, on).catch(() => undefined)} />}
      </div>
    </div>
  )
}
