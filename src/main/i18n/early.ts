/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Imported third by src/main/index.ts (line 3), before app ready:
// reads appLanguage from settings.json synchronously and appends Chromium's
// `lang` switch, so context menus, the spellcheck UI and the chrome's own
// navigator.language follow the app language. Main's catalogue switches here
// too, so anything built before the features start already speaks it. A smoke
// run boots in English with a temp profile, so it never reads the real
// settings.json.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { applyLanguage } from '@shared/i18n/apply'
import { chromiumLang, isAppLanguageSetting, resolveAppLanguage, type AppLanguage, type AppLanguageSetting } from '@shared/i18n/locales'

/** The system's preferred languages, safe before ready. */
export function preferredSystemLanguages(): string[] {
  try {
    const list = app.getPreferredSystemLanguages()
    if (list.length > 0) return list
  } catch {
    // Fall through to the environment.
  }
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
  const tag = env.split('.')[0]?.replace(/_/g, '-')
  if (tag && tag !== 'C' && tag !== 'POSIX') return [tag]
  try {
    return [Intl.DateTimeFormat().resolvedOptions().locale]
  } catch {
    return ['en-US']
  }
}

function readSettingsFile(dataDir: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** settings.json's appLanguage, or 'system' when the file is missing, unreadable or holds something else. */
export function readAppLanguageSetting(dataDir: string): AppLanguageSetting {
  const value = readSettingsFile(dataDir).appLanguage
  return isAppLanguageSetting(value) ? value : 'system'
}

function readFlags(dataDir: string): Record<string, string> {
  const flags = readSettingsFile(dataDir).flags
  if (!flags || typeof flags !== 'object') return {}
  return Object.fromEntries(Object.entries(flags as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
}

/** What Chromium was started with; a later change shows "Some parts switch after a restart". */
export let launchLanguage: AppLanguage = 'en'

export function bootLanguage(dataDir: string, system: readonly string[] = preferredSystemLanguages()): { language: AppLanguage; lang: string } {
  const appLanguage = readAppLanguageSetting(dataDir)
  const language = resolveAppLanguage(appLanguage, system)
  const lang = chromiumLang(language, system)
  launchLanguage = language
  applyLanguage({ appLanguage, flags: readFlags(dataDir) }, system, process.env.APEX_PSEUDO_LOCALE === '1')
  try {
    app.commandLine.appendSwitch('lang', lang)
  } catch {
    // Too late or unsupported: Chromium keeps the system locale.
  }
  return { language, lang }
}

if (process.env.APEX_SMOKE === '1') {
  try {
    app.commandLine.appendSwitch('lang', 'en-US')
  } catch {
    // Smoke still runs in the system locale.
  }
} else {
  try {
    bootLanguage(app.getPath('userData'))
  } catch {
    // No userData yet: Chromium keeps the system locale.
  }
}
