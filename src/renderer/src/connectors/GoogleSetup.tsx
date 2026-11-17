/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { apex } from '../api'
import { useT } from '../i18n/useT'

// The illustrated Google setup. Google wants every app to bring its
// own OAuth client, so these four steps walk through making one. The
// pictures are generic line drawings, drawn
// in currentColor and the theme's tokens so they work in light and dark.

const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials'

function ProjectArt(): ReactElement {
  return (
    <svg viewBox="0 0 120 72" className="cx-art" aria-hidden>
      <rect x="8" y="8" width="104" height="56" rx="8" className="cx-art__panel" />
      <path d="M8 22h104" className="cx-art__rule" />
      <circle cx="17" cy="15" r="2" className="cx-art__dot" />
      <circle cx="24" cy="15" r="2" className="cx-art__dot" />
      <rect x="20" y="32" width="36" height="22" rx="4" className="cx-art__card cx-art__card--on" />
      <path d="M28 40h20M28 46h12" className="cx-art__line" />
      <rect x="64" y="32" width="36" height="22" rx="4" className="cx-art__card" strokeDasharray="4 3" />
      <path d="M82 38v10M77 43h10" className="cx-art__line" />
    </svg>
  )
}

function ApiArt(): ReactElement {
  return (
    <svg viewBox="0 0 120 72" className="cx-art" aria-hidden>
      <rect x="8" y="14" width="64" height="44" rx="8" className="cx-art__panel" />
      <path d="M20 28h28M20 36h40M20 44h20" className="cx-art__line" />
      <rect x="80" y="26" width="32" height="18" rx="9" className="cx-art__track" />
      <circle cx="103" cy="35" r="6" className="cx-art__knob" />
    </svg>
  )
}

function ClientArt(): ReactElement {
  return (
    <svg viewBox="0 0 120 72" className="cx-art" aria-hidden>
      <rect x="10" y="12" width="100" height="48" rx="8" className="cx-art__panel" />
      <circle cx="30" cy="36" r="9" className="cx-art__card cx-art__card--on" />
      <path d="M38 36h14l4 4M48 36v5" className="cx-art__line" />
      <rect x="64" y="24" width="36" height="8" rx="3" className="cx-art__field" />
      <rect x="64" y="40" width="36" height="8" rx="3" className="cx-art__field" />
    </svg>
  )
}

function SignInArt(): ReactElement {
  return (
    <svg viewBox="0 0 120 72" className="cx-art" aria-hidden>
      <rect x="8" y="16" width="44" height="40" rx="8" className="cx-art__panel" />
      <circle cx="30" cy="31" r="6" className="cx-art__line" />
      <path d="M20 48c2-6 18-6 20 0" className="cx-art__line" />
      <path d="M58 36h22m-6-6 6 6-6 6" className="cx-art__line" />
      <rect x="86" y="20" width="26" height="32" rx="8" className="cx-art__card cx-art__card--on" />
      <path d="M93 36l4 4 8-8" className="cx-art__check" />
    </svg>
  )
}

const ART = [ProjectArt, ApiArt, ClientArt, SignInArt]
const STEPS = ['connectors.google.step1', 'connectors.google.step2', 'connectors.google.step3', 'connectors.google.step4'] as const

/** The four steps, each with its drawing; the console link opens in a new tab. */
export function GoogleSetupSteps(): ReactElement {
  const t = useT()
  return (
    <section className="cx-google" aria-label={t('connectors.google.lede')}>
      <p className="cx-muted">{t('connectors.google.lede')}</p>
      <ol className="cx-google__steps">
        {STEPS.map((key, i) => {
          const Art = ART[i] as () => ReactElement
          return (
            <li key={key} className="cx-google__step">
              <Art />
              <span className="cx-google__n">{t('connectors.google.stepLabel', { n: i + 1, total: STEPS.length })}</span>
              <span>{t(key)}</span>
            </li>
          )
        })}
      </ol>
      <button type="button" className="cx-link" onClick={() => void apex.tabs.create(CONSOLE_URL)}>
        {t('connectors.google.openConsole')} <ArrowUpRight size={13} aria-hidden />
      </button>
    </section>
  )
}
