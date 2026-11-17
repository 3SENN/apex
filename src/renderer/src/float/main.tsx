/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import { setLanguage } from '@shared/i18n/core'
import type { FloatLanguage } from '@shared/float'
import { applyMotionSetting } from '../ui/motion'
import { applyFloatTheme, floatApi } from './api'
import { FloatRoot } from './FloatRoot'
import '../styles.css'
import './float.css'

// The floats' page (float.html). Theme, accent, Atelier's own Reduce Motion and
// the app language go on <html> before React renders, and main pushes every
// later change.
function applyFloatLanguage(l: FloatLanguage | undefined): void {
  if (!l) return
  setLanguage(l.language, { locale: l.locale, pseudo: l.pseudo })
  document.documentElement.lang = l.locale
}

if (floatApi) {
  applyFloatTheme(floatApi.initial.theme)
  applyMotionSetting(floatApi.initial.reduceMotion)
  applyFloatLanguage(floatApi.initial.language)
  floatApi.onEvent((e) => {
    if (e.type === 'theme') applyFloatTheme(e.theme)
    else if (e.type === 'language') applyFloatLanguage(e.language)
  })
}

const root = document.getElementById('root')
if (root && floatApi) {
  createRoot(root).render(
    <StrictMode>
      <FloatRoot kind={floatApi.kind} />
    </StrictMode>,
  )
}
