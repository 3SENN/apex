/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactNode } from 'react'
import { applyLanguage, type LanguageInputs } from '@shared/i18n/apply'
import { currentLanguage, currentLocale, pseudoActive } from '@shared/i18n/core'
import { PSEUDO_LOCALE } from '@shared/i18n/locales'
import { call } from '../api'
import { useLanguageVersion } from './useT'

// The i18n provider (ST-27): applies appLanguage from the initial state before the
// first render, and switches the catalogue live on every settings event, so
// useT() consumers relabel without a reload. 'system' starts from the
// chrome's own locale (main launched Chromium with the app language) and is
// refined by main's list of the system's preferred languages.

let systemPreferred: readonly string[] = []
let inputs: LanguageInputs = {}

function browserLanguages(): readonly string[] {
  try {
    return navigator.languages?.length ? navigator.languages : [navigator.language || 'en']
  } catch {
    return ['en']
  }
}

function apply(next: LanguageInputs): void {
  inputs = { appLanguage: next.appLanguage, flags: next.flags }
  applyLanguage(inputs, systemPreferred.length > 0 ? systemPreferred : browserLanguages())
}

function markDocument(): void {
  const root = document.documentElement
  root.lang = pseudoActive() ? PSEUDO_LOCALE : currentLocale()
  root.dataset.appLanguage = currentLanguage()
}

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  // Synchronous on the first render, so no English frame shows before Dutch.
  useState(() => {
    const initial = window.apex?.initial?.settings
    if (initial) apply(initial)
    return null
  })
  const version = useLanguageVersion()

  useEffect(() => {
    // Listeners run before React renders the settings change, so the whole
    // tree re-renders with the new catalogue in one pass.
    const off = window.apex.onAppEvent((event) => {
      if (event.type === 'settings') apply(event.view)
    })
    let live = true
    call('about', 'info')
      .then((info) => {
        if (!live || !info.systemLanguages.length) return
        systemPreferred = info.systemLanguages
        apply(inputs)
      })
      .catch(() => {
        // The chrome's locale stays the guess for 'system'.
      })
    return () => {
      live = false
      off()
    }
  }, [])

  useEffect(markDocument, [version])

  return children
}
