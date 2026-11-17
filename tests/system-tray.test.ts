/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { describe, expect, it } from 'vitest'
import { t } from '../src/shared/i18n/core'
import { TRAY_IDS, nextRunLabel, trayImageFile, trayMenuItems, trayTemplate, type TrayStatus } from '../src/main/system/tray'

// The tray menu builder: what it lists in each state.

const fmt = { time: (at: number) => `T${new Date(at).getHours()}`, date: (at: number) => `D${new Date(at).getDate()}` }
const idle: TrayStatus = { recording: 'none', nextRunAt: null, needsYou: 0, updateReady: false }

function at(base: Date, days: number, hours: number): number {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  d.setHours(hours, 0, 0, 0)
  return d.getTime()
}

describe('trayMenuItems', () => {
  const now = at(new Date(2026, 9, 29), 0, 8)

  it('lists Open, New Window, New Chat, the status line and Quit, in that order', () => {
    const items = trayMenuItems(idle, now, t, fmt)
    expect(items.filter((i) => i.type !== 'separator').map((i) => i.id)).toEqual([TRAY_IDS.open, TRAY_IDS.newWindow, TRAY_IDS.newChat, TRAY_IDS.status, TRAY_IDS.quit])
    expect(items.find((i) => i.id === TRAY_IDS.status)).toMatchObject({ label: 'No routines scheduled', enabled: false })
    expect(items.find((i) => i.id === TRAY_IDS.quit)).toMatchObject({ label: `Quit ${BRAND_NAME}`, commandId: 'quit' })
  })

  it('shows the next routine run', () => {
    const items = trayMenuItems({ ...idle, nextRunAt: at(new Date(now), 0, 14) }, now, t, fmt)
    expect(items.find((i) => i.id === TRAY_IDS.status)?.label).toBe('Next routine at T14')
  })

  it('puts a recording first, with Stop', () => {
    const items = trayMenuItems({ ...idle, recording: 'recording', nextRunAt: at(new Date(now), 0, 14) }, now, t, fmt)
    expect(items.find((i) => i.id === TRAY_IDS.status)?.label).toBe('Recording a meeting')
    expect(items.some((i) => i.id === TRAY_IDS.stopRecording)).toBe(true)
    expect(trayMenuItems({ ...idle, recording: 'paused' }, now, t, fmt).find((i) => i.id === TRAY_IDS.status)?.label).toBe('Meeting recording paused')
    expect(trayMenuItems(idle, now, t, fmt).some((i) => i.id === TRAY_IDS.stopRecording)).toBe(false)
  })

  it('counts chats that need you, and offers a ready update', () => {
    const items = trayMenuItems({ ...idle, needsYou: 2, updateReady: true }, now, t, fmt)
    expect(items.find((i) => i.id === TRAY_IDS.needsYou)?.label).toBe('2 chats need you')
    expect(items.find((i) => i.id === TRAY_IDS.update)?.label).toBe('Restart to Update')
    expect(trayMenuItems({ ...idle, needsYou: 1 }, now, t, fmt).find((i) => i.id === TRAY_IDS.needsYou)?.label).toBe('1 chat needs you')
  })
})

describe('nextRunLabel', () => {
  const now = at(new Date(2026, 9, 29), 0, 8)
  it('says today, tomorrow, a later day, or due now', () => {
    expect(nextRunLabel(null, now, t, fmt)).toBe('No routines scheduled')
    expect(nextRunLabel(now + 30_000, now, t, fmt)).toBe('A routine is about to run')
    expect(nextRunLabel(at(new Date(now), 0, 23), now, t, fmt)).toBe('Next routine at T23')
    expect(nextRunLabel(at(new Date(now), 1, 9), now, t, fmt)).toBe('Next routine tomorrow at T9')
    const later = at(new Date(now), 4, 9)
    expect(nextRunLabel(later, now, t, fmt)).toBe(`Next routine D${new Date(later).getDate()} at T9`)
  })
})

describe('tray images and template', () => {
  it('picks the template image on macOS and the taskbar-matched icon on Windows', () => {
    expect(trayImageFile('darwin', false)).toBe('trayTemplate.png')
    expect(trayImageFile('win32', false)).toBe('tray-light.ico')
    expect(trayImageFile('win32', true)).toBe('tray-dark.ico')
    expect(trayImageFile('linux', true)).toBe('tray.png')
  })

  it('turns the model into Electron items that report their id', () => {
    const picked: string[] = []
    const template = trayTemplate(trayMenuItems(idle, Date.now(), t, fmt), (item) => picked.push(item.id))
    expect(template.filter((i) => i.type === 'separator')).toHaveLength(2)
    const quit = template.find((i) => i.id === TRAY_IDS.quit)
    ;(quit?.click as () => void)()
    expect(picked).toEqual([TRAY_IDS.quit])
    expect(template.find((i) => i.id === TRAY_IDS.status)?.enabled).toBe(false)
  })
})
