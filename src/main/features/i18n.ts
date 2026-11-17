/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Session } from 'electron'
import { currentLanguage } from '@shared/i18n/core'
import { withAppLanguageFirst } from '@shared/i18n/locales'
import { menus } from '@shared/menuModel'
import type { Settings } from '@shared/ipc'
import { setupI18n, type I18nHandle } from '../i18n/setup'
import { applySessionLanguages, languagesFor } from '../languages'
import type { AppContext, Feature } from './types'

// The i18n feature module: the app language in main. Menus rebuild on a change;
// missing Dutch keys go to the log once each. While ST-32's website
// languages follow the system, every session's Accept-Language puts the app
// language first. This feature runs after the settings feature, so its
// session hook and change listener land after its plain system list.

let handle: I18nHandle | null = null
let context: AppContext | null = null
const sessions = new Set<Session>()

/** The website languages a session gets while they follow the system, or null for a custom list (the settings feature's alone). */
export function followingLanguages(settings: Pick<Settings, 'languages'>): string[] | null {
  if (settings.languages.mode !== 'system') return null
  return withAppLanguageFirst(languagesFor(settings), currentLanguage())
}

function applyAccept(session: Session, settings: Settings): void {
  const list = followingLanguages(settings)
  if (list) applySessionLanguages(session, list)
}

function onSettingsChanged(next: Settings, previous: Settings): void {
  if (next.appLanguage === previous.appLanguage && JSON.stringify(next.languages) === JSON.stringify(previous.languages)) return
  for (const session of sessions) applyAccept(session, next)
}

export const i18nFeature: Feature = {
  name: 'i18n',
  app(ctx) {
    context = ctx
    handle = setupI18n({ settings: ctx.settings, menus, dataDir: ctx.dataDir, smoke: ctx.smoke })
    // After setupI18n's listener, so the catalogue has switched first.
    ctx.settings.on('changed', onSettingsChanged)
    return handle.services
  },
  session(session) {
    if (!context) return
    sessions.add(session)
    applyAccept(session, context.settings.get())
  },
  dispose() {
    context?.settings.off('changed', onSettingsChanged)
    handle?.dispose()
    handle = null
    context = null
    sessions.clear()
  },
}
