/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyLanguage, PSEUDO_FLAG, type LanguageInputs } from '@shared/i18n/apply'
import { currentLanguage, currentLocale, pseudoActive, setMissingKeyReporter } from '@shared/i18n/core'
import { negotiate } from '@shared/i18n/locales'
import { log } from '../log'
import { systemLanguages } from '../languages'
import type { SettingsStore } from '../settings'
import { launchLanguage } from './early'

// The main-side language wiring (ST-27): main speaks the app language from
// the start, a missing Dutch key falls back to English and is logged once,
// and an appLanguage (or pseudo-locale) change switches the catalogue and
// rebuilds the native menus at once. Chromium's own menus wait for a restart,
// which the Languages card offers.

type I18nSettings = Pick<SettingsStore, 'get' | 'update' | 'on' | 'off'>

export interface I18nDeps {
  settings: I18nSettings
  /** Rebuilds the native menus in the new language. */
  menus: { invalidate(): void }
  /** userData: where the ATELIER_PSEUDO_LOCALE marker lives. Without it the variable only affects main. */
  dataDir?: string
  /** The system's preferred languages (tests pass a list). */
  systemLanguages?: () => readonly string[]
  env?: Record<string, string | undefined>
  /** Smoke runs resolve 'system' to English, whatever the machine speaks. */
  smoke?: boolean
}

export interface I18nHandle {
  services: Record<string, never>
  /** The language Chromium started in; a different app language needs a restart for context menus and spellcheck. */
  launchLanguage: string
  dispose(): void
}

const PSEUDO_MARKER = 'pseudo-locale-env.json'

// ATELIER_PSEUDO_LOCALE=1 turns the pseudo-locale flag on for this launch so the chrome shows
// en-XA too; the marker keeps the value it replaced, and the next launch
// without the variable puts it back.
function syncPseudoEnv(deps: I18nDeps, env: Record<string, string | undefined>): void {
  if (!deps.dataDir) return
  const marker = join(deps.dataDir, PSEUDO_MARKER)
  const flags = deps.settings.get().flags ?? {}
  try {
    if (env.ATELIER_PSEUDO_LOCALE === '1') {
      if (flags[PSEUDO_FLAG] === 'on') return
      writeFileSync(marker, JSON.stringify({ previous: flags[PSEUDO_FLAG] ?? null }))
      deps.settings.update({ flags: { ...flags, [PSEUDO_FLAG]: 'on' } })
      log.info('i18n', 'ATELIER_PSEUDO_LOCALE=1: the pseudo-locale is on for this launch')
    } else if (existsSync(marker)) {
      const saved = JSON.parse(readFileSync(marker, 'utf8')) as { previous?: string | null }
      const next = { ...flags }
      if (typeof saved.previous === 'string') next[PSEUDO_FLAG] = saved.previous
      else delete next[PSEUDO_FLAG]
      rmSync(marker, { force: true })
      deps.settings.update({ flags: next })
      log.info('i18n', 'The pseudo-locale from ATELIER_PSEUDO_LOCALE is off again')
    }
  } catch (err) {
    log.warn('i18n', 'Could not sync ATELIER_PSEUDO_LOCALE with the pseudo-locale flag', { error: err instanceof Error ? err.message : String(err) })
  }
}

function inputsOf(settings: { appLanguage?: unknown; flags?: Record<string, string> }): LanguageInputs {
  return { appLanguage: settings.appLanguage as LanguageInputs['appLanguage'], flags: settings.flags }
}

export function setupI18n(deps: I18nDeps): I18nHandle {
  const env = deps.env ?? process.env
  const forcePseudo = env.ATELIER_PSEUDO_LOCALE === '1' && !deps.dataDir
  const system = (): readonly string[] => (deps.smoke ? ['en-US'] : (deps.systemLanguages ?? systemLanguages)())

  setMissingKeyReporter((key, language) => log.warn('i18n', `No ${language} text for ${key} yet; showing English`))
  syncPseudoEnv(deps, env)
  applyLanguage(inputsOf(deps.settings.get()), system(), forcePseudo)
  // Menus built before this feature started may still be in early.ts's guess.
  if (currentLanguage() !== 'en' || pseudoActive()) deps.menus.invalidate()
  log.info('i18n', `App language ${currentLanguage()} (${currentLocale()})${pseudoActive() ? ', pseudo-locale on' : ''}`)

  const onChanged = (next: { appLanguage?: unknown; flags?: Record<string, string> }, previous: { appLanguage?: unknown; flags?: Record<string, string> }): void => {
    if (next.appLanguage === previous.appLanguage && next.flags?.[PSEUDO_FLAG] === previous.flags?.[PSEUDO_FLAG]) return
    if (!applyLanguage(inputsOf(next), system(), forcePseudo)) return
    log.info('i18n', `App language is now ${currentLanguage()} (${currentLocale()})${pseudoActive() ? ', pseudo-locale on' : ''}`)
    try {
      deps.menus.invalidate()
    } catch (err) {
      log.warn('i18n', 'Could not rebuild the menus after a language change', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  deps.settings.on('changed', onChanged)

  return {
    services: {},
    launchLanguage: deps.smoke ? negotiate(['en-US']) : launchLanguage,
    dispose: () => {
      deps.settings.off('changed', onChanged)
    },
  }
}
