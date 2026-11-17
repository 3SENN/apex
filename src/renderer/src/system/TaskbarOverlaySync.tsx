/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Windows taskbar overlay icons (ST-09). The chrome draws the three
// images and hands them to main, which shows one by priority: a waiting
// approval, then unread results, then the companion chosen in the Dock-icon
// setting (a frameless floating head, 32 px). Redrawn when the theme or the
// chosen companion changes. Renders nothing.
import { useEffect, useState } from 'react'
import type { SettingsView } from '@shared/ipc'
import { lookKey } from '@shared/companionLogic'
import { atelier, call } from '../api'
import { companionImage } from '../companion'
import { useCompanions } from '../components/shellContext'
import { useEvent } from '../settings/data'
import { useResolvedTheme } from '../ui'
import { useT } from '../i18n/useT'
import { attentionBadge, unreadBadge } from './badges'

const OVERLAY_PX = 32

export function TaskbarOverlaySync(): null {
  const t = useT()
  const theme = useResolvedTheme()
  const [settings, setSettings] = useState<SettingsView>(atelier.initial.settings)
  useEvent('settings', (e) => setSettings(e.view))
  const { list } = useCompanions()

  // The badges follow the theme's tokens.
  useEffect(() => {
    // Wait a frame so data-theme has switched before the tokens are read.
    const frame = requestAnimationFrame(() => {
      void call('system', 'setTaskbarOverlay', 'attention', attentionBadge(), t('system.taskbar.attention')).catch(() => undefined)
      void call('system', 'setTaskbarOverlay', 'unread', unreadBadge(), t('system.taskbar.unread', { count: 1 })).catch(() => undefined)
    })
    return () => cancelAnimationFrame(frame)
  }, [theme])

  const choice = settings.dockIcon
  const companion = choice.kind === 'companion' ? (list.find((c) => c.id === choice.companionId) ?? null) : null
  const key = companion ? `${companion.id}:${lookKey(companion.look)}` : 'standard'
  useEffect(() => {
    if (!companion) {
      void call('system', 'setTaskbarOverlay', 'companion', null, '').catch(() => undefined)
      return
    }
    let live = true
    companionImage(companion.look, OVERLAY_PX, 'idle', { framing: 'face' })
      .then((png) => (live ? call('system', 'setTaskbarOverlay', 'companion', png, companion.name) : undefined))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key])
  return null
}
