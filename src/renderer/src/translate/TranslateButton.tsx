/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useRef, useState, type ReactElement } from 'react'
import type { TabTranslate } from '@shared/translate'
import { Languages } from 'lucide-react'
import { useLanguage, useT } from '../i18n/useT'
import { useSurface } from '../overlay/useSurface'
import { Spinner, cx } from '../ui'
import { languageNamer } from './names'
import './translate.css'

// The translate button in the address pill (TR-01, TR-11): it shows on pages
// in a language that is not one of yours, turns solid while the page is
// translated, spins while it works and carries a dot when translating failed.
// A click opens the translate popover, which follows the tab's state.

export function TranslateButton({ tabId, state, companion }: { tabId: string; state: TabTranslate; companion: string }): ReactElement {
  const t = useT()
  const { locale } = useLanguage()
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const key = JSON.stringify(state)
  // Keyed by the state's content, not its identity: every tab snapshot brings a new object.
  const props = useMemo(() => ({ tabId, state, companion }), [tabId, key, companion]) // eslint-disable-line react-hooks/exhaustive-deps
  useSurface('translate-popover', { open, anchor: button, props, onResult: () => setOpen(false), prewarmOnHover: true })

  const language = languageNamer(locale)(state.language)
  const label =
    state.status === 'translated'
      ? t('translate.button.translated', { language })
      : state.status === 'translating'
        ? t('translate.button.translating')
        : state.status === 'error'
          ? t('translate.button.error')
          : t('translate.button.offer')

  return (
    <button
      ref={button}
      type="button"
      className={cx('pill__translate', state.status === 'translated' && 'pill__translate--on', state.status === 'error' && 'pill__translate--error', state.status === 'offer' && 'pill__translate--offer')}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={label}
      data-translate-status={state.status}
      onClick={() => setOpen((o) => !o)}
    >
      {state.status === 'translating' ? <Spinner size={13} label={label} /> : <Languages size={14} aria-hidden />}
    </button>
  )
}
