/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { DownloadInfo } from '@shared/services'
import { Download } from 'lucide-react'
import { useDownloadsPopover } from '../../overlay/surfaces/menus/downloads/useDownloadsPopover'
import { IconButton, cx, type ControlSize } from '../../ui'
import { downloadProgress } from './logic/cues'
import { useT } from '../../i18n/useT'

/**
 * The downloads button: in the sidebar header (or the horizontal toolbar),
 * only while there are downloads. A new download makes it pulse a highlight
 * once; a thin bar along its bottom shows the progress of running ones.
 */
export function DownloadsButton({ downloads, size = 'sm', className }: { downloads: DownloadInfo[]; size?: ControlSize; className?: string }): ReactElement | null {
  const t = useT()
  const known = useRef<Set<string> | null>(null)
  const [pulse, setPulse] = useState(0)
  useEffect(() => {
    const ids = new Set(downloads.map((d) => d.id))
    // The first list is history, not news.
    if (known.current && downloads.some((d) => !known.current?.has(d.id))) setPulse((p) => p + 1)
    known.current = ids
  }, [downloads])
  // OV-17 to OV-19: the click toggles the popover; new downloads fly in and may open it
  const anchor = useRef<HTMLSpanElement>(null)
  const popover = useDownloadsPopover(anchor, downloads)

  if (downloads.length === 0) return null
  const progress = downloadProgress(downloads)
  const running = downloads.filter((d) => d.state === 'progressing').length
  return (
    <span ref={anchor} className={cx('downloads-btn', className)}>
      <IconButton
        size={size}
        label={running ? `Downloads, ${running} in progress` : t('tabs.sidebarDownloadsButton.downloads')}
        shortcut="CmdOrCtrl+Shift+J"
        icon={<Download />}
        className={popover.open ? 'ui-icon-btn--on' : undefined}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        onClick={popover.toggle}
      />
      {pulse > 0 && <span key={pulse} className="downloads-btn__pulse" aria-hidden />}
      {progress !== undefined && (
        <span className={cx('downloads-btn__bar', progress === null && 'downloads-btn__bar--unknown')} aria-hidden>
          <i style={progress === null ? undefined : { width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
    </span>
  )
}
