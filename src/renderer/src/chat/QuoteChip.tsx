/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { Quote, X } from 'lucide-react'
import { quoteHost, quotePreview } from '@shared/quote'
import { useT } from '../i18n/useT'
import { clearQuote, useQuote } from './quoteInbox'
import './quoteChip.css'

// The quoted selection above the panel composer's field (OV-20): where it
// came from, a one-line preview and how many links it carries. × removes it.

export function QuoteChip({ enabled }: { enabled: boolean }): ReactElement | null {
  const t = useT()
  const quote = useQuote(enabled)
  if (!quote) return null
  const host = quoteHost(quote.url)
  const preview = quotePreview(quote.text || quote.url)
  return (
    <div className="quote-chip" role="group" aria-label={t('atWork.quote.label', { host })}>
      <Quote className="quote-chip__icon" aria-hidden="true" />
      <div className="quote-chip__text">
        <span className="quote-chip__source">
          {t('atWork.quote.label', { host })}
          {quote.links.length > 0 && <span className="quote-chip__links"> · {t('atWork.quote.links', { count: quote.links.length })}</span>}
        </span>
        <span className="quote-chip__preview" title={quote.text || quote.url}>
          {preview}
        </span>
      </div>
      <button type="button" className="quote-chip__remove" aria-label={t('atWork.quote.remove')} title={t('atWork.quote.remove')} onClick={clearQuote}>
        <X aria-hidden="true" />
      </button>
    </div>
  )
}
