/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUTOSTART_FILE, LinuxAutostart, autostartContent, autostartDir, execArg, parseAutostart, type AutostartFs } from '../src/main/system/autostartLinux'

// The Linux autostart entry: its content, quoting and removal.

function memoryFs(): AutostartFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    exists: (p) => files.has(p),
    read: (p) => {
      const text = files.get(p)
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    write: (p, text) => void files.set(p, text),
    remove: (p) => void files.delete(p),
  }
}

const entry = { launcher: '/home/me/Apps/Apex.AppImage', name: 'Apex', comment: 'Apex starts when you sign in.' }

describe('autostartDir', () => {
  it('uses XDG_CONFIG_HOME when absolute, else ~/.config', () => {
    expect(autostartDir({ XDG_CONFIG_HOME: '/x/config' }, '/home/me')).toBe(join('/x/config/autostart'))
    expect(autostartDir({}, '/home/me')).toBe(join('/home/me/.config/autostart'))
    expect(autostartDir({ XDG_CONFIG_HOME: 'relative' }, '/home/me')).toBe(join('/home/me/.config/autostart'))
  })
})

describe('execArg', () => {
  it('leaves plain paths alone and quotes reserved characters per the Desktop Entry spec', () => {
    expect(execArg('/opt/Apex/apex')).toBe('/opt/Apex/apex')
    expect(execArg('/home/me/My Apps/Apex.AppImage')).toBe('"/home/me/My Apps/Apex.AppImage"')
    // A quoted $ is \$, and the string rule doubles the backslash.
    expect(execArg('/home/me/$x/apex')).toBe('"/home/me/\\\\$x/apex"')
    expect(execArg('/a"b')).toBe('"/a\\\\"b"')
    expect(execArg('/a\\b')).toBe('"/a\\\\\\\\b"')
    expect(execArg('/100%/apex')).toBe('/100%%/apex')
  })
})

describe('autostartContent', () => {
  it('starts the launcher with the login flag, enabled for GNOME too', () => {
    const text = autostartContent(entry)
    expect(text.startsWith('[Desktop Entry]\n')).toBe(true)
    expect(text).toContain('\nType=Application\n')
    expect(text).toContain('\nExec=/home/me/Apps/Apex.AppImage --background\n')
    expect(text).toContain('\nX-GNOME-Autostart-enabled=true\n')
    expect(text).not.toContain('Hidden=')
    expect(parseAutostart(text, entry.launcher)).toEqual({ enabled: true, current: true })
  })

  it('keeps names on one line', () => {
    expect(autostartContent({ ...entry, comment: 'one\ntwo' })).toContain('\nComment=one two\n')
  })
})

describe('parseAutostart', () => {
  it('reads Hidden and the GNOME switch as off, and spots a moved launcher', () => {
    const text = autostartContent(entry)
    expect(parseAutostart(`${text}Hidden=true\n`, entry.launcher).enabled).toBe(false)
    expect(parseAutostart(text.replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'), entry.launcher).enabled).toBe(false)
    expect(parseAutostart(text, '/elsewhere/Apex.AppImage')).toEqual({ enabled: true, current: false })
    expect(parseAutostart('[Other]\nExec=x\n', entry.launcher).enabled).toBe(false)
  })
})

describe('LinuxAutostart', () => {
  it('writes the entry, reads it back and removes it', () => {
    const fs = memoryFs()
    const auto = new LinuxAutostart({ dir: '/home/me/.config/autostart', entry, fs })
    expect(auto.path).toBe(join('/home/me/.config/autostart', AUTOSTART_FILE))
    expect(auto.enabled()).toBe(false)
    auto.enable()
    expect(auto.enabled()).toBe(true)
    expect(fs.files.get(auto.path)).toBe(autostartContent(entry))
    auto.disable()
    expect(auto.enabled()).toBe(false)
    expect(fs.files.size).toBe(0)
  })

  it('rewrites an enabled entry that points at a moved AppImage, and leaves a disabled one alone', () => {
    const fs = memoryFs()
    const old = new LinuxAutostart({ dir: '/c', entry: { ...entry, launcher: '/old/Apex.AppImage' }, fs })
    old.enable()
    const now = new LinuxAutostart({ dir: '/c', entry, fs })
    now.refresh()
    expect(fs.files.get(now.path)).toBe(autostartContent(entry))
    fs.files.set(now.path, `${autostartContent({ ...entry, launcher: '/old/Apex.AppImage' })}Hidden=true\n`)
    now.refresh()
    expect(fs.files.get(now.path)).toContain('/old/Apex.AppImage')
  })
})
