/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useSyncExternalStore } from 'react'
import { currentLanguage, currentLocale, onLanguageChange, pseudoActive, t, type MessageKey, type MessageVars } from '@shared/i18n/core'
import type { AppLanguage } from '@shared/i18n/locales'

// The chrome's string lookup. useT() re-renders its
// component when the app language changes; the plain `t` export reads the
// active language too, for code outside components.
export type T = (key: MessageKey, vars?: MessageVars) => string

// Bumped before React hears of a change, so every snapshot after it is new.
let version = 0
onLanguageChange(() => {
  version++
})

function subscribe(listener: () => void): () => void {
  return onLanguageChange(listener)
}

const snapshot = (): number => version

/** A number that changes with the app language; a dependency for memos built from strings. */
export function useLanguageVersion(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** The active language, its Intl tag, and whether en-XA is on; re-renders on a change. */
export function useLanguage(): { language: AppLanguage; locale: string; pseudo: boolean } {
  const v = useLanguageVersion()
  return useMemo(() => ({ language: currentLanguage(), locale: currentLocale(), pseudo: pseudoActive() }), [v])
}

export function useT(): T {
  const v = useLanguageVersion()
  // A fresh function per language, so memos and effects that list `t` rerun.
  return useMemo<T>(() => (key, vars) => t(key, vars), [v])
}

export { t }
export type { MessageKey, MessageVars }
