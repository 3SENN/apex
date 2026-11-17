/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Language names for page translation (TR-11), in Apex's own language.
import { COMMON_LANGUAGE_TAGS } from '@shared/languages'
import { languageKey } from '@shared/translate'

export type LanguageNamer = (tag: string) => string

/** Names languages in `locale` ('fr' → 'French', or 'Frans' in Dutch); the tag itself when Intl can't. */
export function languageNamer(locale: string): LanguageNamer {
  let names: Intl.DisplayNames | null = null
  try {
    names = new Intl.DisplayNames([locale, 'en'], { type: 'language' })
  } catch {
    names = null
  }
  return (tag) => {
    try {
      return names?.of(tag) ?? tag
    } catch {
      return tag
    }
  }
}

/** The languages a page can be translated into: one per language key, by name, with `current` among them. */
export function targetChoices(name: LanguageNamer, current: string | null): Array<{ value: string; label: string }> {
  const keys = new Set<string>()
  for (const tag of COMMON_LANGUAGE_TAGS) {
    const key = languageKey(tag)
    if (key) keys.add(key)
  }
  const now = languageKey(current)
  if (now) keys.add(now)
  return [...keys].map((value) => ({ value, label: name(value) })).sort((a, b) => a.label.localeCompare(b.label))
}
