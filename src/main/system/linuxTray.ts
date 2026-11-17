/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFile } from 'node:child_process'

// Linux tray support varies: Electron's tray is a StatusNotifierItem, shown
// only when the session runs a StatusNotifierWatcher (KDE, or GNOME with the
// AppIndicator extension); some panels still take the older XEmbed tray.
// Without either, background mode would leave Apex running invisibly, so the
// row is hidden (trayAvailable() false).

/** Panels that host tray icons even without a watcher on the bus. */
const TRAY_DESKTOPS = /\b(kde|xfce|lxqt|lxde|mate|cinnamon|budgie|unity|deepin|enlightenment|i3|sway)\b/i

/** Pure: the watcher probe (null when it couldn't run) and $XDG_CURRENT_DESKTOP. */
export function linuxTrayAvailable(o: { watcher: boolean | null; desktop: string }): boolean {
  if (o.watcher === true) return true
  if (TRAY_DESKTOPS.test(o.desktop)) return true
  // GNOME without the extension has no tray; an unknown desktop with an unanswered probe gets the benefit of the doubt.
  if (o.watcher === false || /gnome/i.test(o.desktop)) return false
  return o.desktop.trim() !== ''
}

/** Asks the session bus whether a StatusNotifierWatcher is running; null when gdbus isn't there. */
export function probeStatusNotifier(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile(
      'gdbus',
      ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.kde.StatusNotifierWatcher'],
      { timeout: 2000, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : /\btrue\b/.test(stdout)),
    )
  })
}
