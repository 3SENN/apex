/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { BookOpen } from 'lucide-react'
import type { TabInfo } from '@shared/ipc'
import { call, errorText } from '../api'
import { useSettingsView } from '../chat/hooks'
import { useT } from '../i18n/useT'
import { cx, isMac, toast, tooltipText } from '../ui'
import { ariaKeyShortcut } from '../ui/logic/shortcut'

// The address pill's reader button (RD-03): it shows only while the page
// reads as an article (or the reader is open), and toggles the reader.

const SHORTCUT = 'Alt+CmdOrCtrl+R'

export function ReaderButton({ tab }: { tab: TabInfo | null }): ReactElement | null {
  const t = useT()
  const settings = useSettingsView()
  const state = tab?.reader
  if (!tab || !state || (!settings.readerButton && state !== 'open')) return null
  const open = state === 'open'
  const label = open ? t('reader.pill.close') : t('reader.pill.open')
  return (
    <button
      type="button"
      className={cx('pill__star', 'pill__reader', open && 'pill__reader--on')}
      aria-label={label}
      aria-pressed={open}
      aria-keyshortcuts={ariaKeyShortcut(SHORTCUT, isMac)}
      title={tooltipText(label, SHORTCUT, isMac)}
      onClick={() => void call('reader', 'toggle', tab.id).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))}
    >
      <BookOpen size={15} aria-hidden />
    </button>
  )
}
