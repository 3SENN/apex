/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { MAX_LAUNCH_TARGETS, fileUrl, firstLaunchEvents, linkWindow, parseLaunchArgs } from '../src/main/system/secondInstance'

// The second-instance argv parsing: URLs, web files,
// companion files, quoted paths, and flags ignored.

describe('parseLaunchArgs', () => {
  const posix = { cwd: '/home/me', platform: 'linux' as const }
  const windows = { cwd: 'C:\\Users\\me', platform: 'win32' as const }

  it('takes http(s) and file URLs, and ignores other schemes', () => {
    const out = parseLaunchArgs(['/opt/Apex/apex', 'https://example.com/a?b=1', 'http://x.test', 'file:///home/me/a.html', 'javascript:alert(1)', 'mailto:a@b.c', 'ftp://x.test/f'], posix)
    expect(out.urls).toEqual(['https://example.com/a?b=1', 'http://x.test/', 'file:///home/me/a.html'])
    expect(out.companionFiles).toEqual([])
  })

  it('ignores the executable, flags and the dev app folder', () => {
    const out = parseLaunchArgs(['electron', '.', '--allow-file-access-from-files', '--original-process-start-time=1', '-psn_0_1', '--', 'https://a.test'], posix)
    expect(out).toEqual({ urls: ['https://a.test/'], companionFiles: [], background: false })
  })

  it('notes a login launch', () => {
    expect(parseLaunchArgs(['apex', '--background'], posix)).toEqual({ urls: [], companionFiles: [], background: true })
  })

  it('opens web files as file URLs and sends .apexcompanion files to the import review', () => {
    const out = parseLaunchArgs(['apex', 'page.html', '/tmp/Pip.APEXCOMPANION', 'notes.txt', 'Downloads/pic.svg'], posix)
    expect(out.urls).toEqual(['file:///home/me/page.html', 'file:///home/me/Downloads/pic.svg'])
    expect(out.companionFiles).toEqual(['/tmp/Pip.APEXCOMPANION'])
  })

  it('handles quoted Windows paths, relative ones and spaces', () => {
    const out = parseLaunchArgs(['C:\\Program Files\\Apex\\Apex.exe', '"C:\\Users\\me\\My Pages\\a b.html"', 'docs\\c.htm', '"D:\\Pip.apexcompanion"'], windows)
    expect(out.urls).toEqual(['file:///C:/Users/me/My%20Pages/a%20b.html', 'file:///C:/Users/me/docs/c.htm'])
    expect(out.companionFiles).toEqual(['D:\\Pip.apexcompanion'])
  })

  it('skips paths that are not files when it can check', () => {
    const out = parseLaunchArgs(['apex', 'here.html', 'gone.html'], { ...posix, isFile: (p) => p.endsWith('here.html') })
    expect(out.urls).toEqual(['file:///home/me/here.html'])
  })

  it('stops after a sane number of targets', () => {
    const many = Array.from({ length: 50 }, (_, i) => `https://a.test/${i}`)
    expect(parseLaunchArgs(['apex', ...many], posix).urls).toHaveLength(MAX_LAUNCH_TARGETS)
  })
})

describe('fileUrl', () => {
  it('encodes per platform, including UNC shares', () => {
    expect(fileUrl('/home/me/a #1.html', 'linux')).toBe('file:///home/me/a%20%231.html')
    expect(fileUrl('C:\\a\\b.html', 'win32')).toBe('file:///C:/a/b.html')
    expect(fileUrl('\\\\server\\share\\p.html', 'win32')).toBe('file://server/share/p.html')
  })
})

describe('where opened links go', () => {
  const normal = { id: 1, kind: 'normal' }
  const other = { id: 2, kind: 'normal' }
  const priv = { id: 3, kind: 'private' }
  const chat = { id: 4, kind: 'chat' }

  it('uses the front window when it is a normal one', () => {
    expect(linkWindow(other, [normal, other])).toBe(other)
  })

  it('never uses a private or chat window, falling back to the first normal one', () => {
    expect(linkWindow(priv, [priv, normal, other])).toBe(normal)
    expect(linkWindow(chat, [chat, other])).toBe(other)
    expect(linkWindow(null, [priv, other])).toBe(other)
  })

  it('has none when only private or chat windows are open', () => {
    expect(linkWindow(priv, [priv, chat])).toBeNull()
    expect(linkWindow(null, [])).toBeNull()
  })
})

describe('a Windows or Linux cold start', () => {
  it('turns its links into open-url and its companion files into open-file, in order', () => {
    const targets = parseLaunchArgs(['C:\\Apex\\Apex.exe', '--background', 'https://example.com/', 'C:\\me\\Ada.apexcompanion'], { cwd: 'C:\\me', platform: 'win32', isFile: () => true })
    expect(firstLaunchEvents(targets)).toEqual([
      { event: 'open-url', value: 'https://example.com/' },
      { event: 'open-file', value: 'C:\\me\\Ada.apexcompanion' },
    ])
  })

  it('has nothing to send for a plain start', () => {
    expect(firstLaunchEvents(parseLaunchArgs(['/opt/Apex/apex', '--no-sandbox'], { cwd: '/home/me', platform: 'linux' }))).toEqual([])
  })
})
