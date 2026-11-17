/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { currentLanguage, currentLocale, t, type MessageKey, type MessageVars } from '@shared/i18n/core'

// Main's string lookup for menus, notifications, dialogs, the tray, the
// crash-recovery page and the in-page overlay label. It
// reads the app language setupI18n applies; call it when the text is
// shown, never at import, so a language change reaches the next build.
export function mainT(key: MessageKey, vars?: MessageVars): string {
  return t(key, vars)
}

/** The app language main speaks now, and its Intl tag. */
export function mainLanguage(): { language: ReturnType<typeof currentLanguage>; locale: string } {
  return { language: currentLanguage(), locale: currentLocale() }
}

export type { MessageKey, MessageVars }
