/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import {
  AUTO_OPEN_MAX_BYTES,
  FLIGHT_MAX_MS,
  downloadActions,
  downloadPercent,
  downloadPhase,
  downloadStatus,
  etaSeconds,
  fileKind,
  flightDuration,
  flightFrames,
  flightPoint,
  formatSize,
  formatTimeLeft,
  isClearable,
  nextSpeed,
  shouldAutoOpen,
  toDownloadRow,
  type DownloadRow,
} from '@shared/downloads'

// The downloads' pure rules: speed and time left, auto-open, danger states,
// file kinds, the status line and the flight's curve.

const row = (patch: Partial<DownloadRow> = {}): DownloadRow => ({
  id: 'd1',
  url: 'https://files.example.com/report.pdf',
  filename: 'report.pdf',
  state: 'progressing',
  receivedBytes: 0,
  totalBytes: 0,
  startedAt: 1,
  speedBps: 0,
  etaSeconds: null,
  danger: 'none',
  byAgent: false,
  mime: 'application/pdf',
  ...patch,
})

describe('speed and time left', () => {
  it('starts at zero, takes the first interval outright, then smooths', () => {
    const first = nextSpeed(null, 0, 1000)
    expect(first.bps).toBe(0)
    const second = nextSpeed(first, 1_000_000, 2000)
    expect(second.bps).toBe(1_000_000)
    const third = nextSpeed(second, 1_500_000, 3000)
    // 0.3 of the way from 1 MB/s toward 0.5 MB/s.
    expect(third.bps).toBeCloseTo(850_000)
  })

  it('folds samples closer than 200 ms into the next one', () => {
    const a = nextSpeed(nextSpeed(null, 0, 0), 1000, 1000)
    expect(nextSpeed(a, 5000, 1100)).toBe(a)
    const b = nextSpeed(a, 3000, 2000)
    expect(b.at).toBe(2000)
  })

  it('never goes negative when bytes go backwards', () => {
    const a = nextSpeed(nextSpeed(null, 0, 0), 1000, 1000)
    expect(nextSpeed(a, 0, 2000).bps).toBeGreaterThanOrEqual(0)
  })

  it('computes whole seconds left, or null when size or speed is unknown', () => {
    expect(etaSeconds(500, 1500, 100)).toBe(10)
    expect(etaSeconds(1499, 1500, 1000)).toBe(1)
    expect(etaSeconds(2000, 1500, 1000)).toBe(0)
    expect(etaSeconds(0, 0, 100)).toBeNull()
    expect(etaSeconds(0, 100, 0)).toBeNull()
  })

  it('reports percent only for a known size', () => {
    expect(downloadPercent({ receivedBytes: 50, totalBytes: 200 })).toBe(25)
    expect(downloadPercent({ receivedBytes: 300, totalBytes: 200 })).toBe(100)
    expect(downloadPercent({ receivedBytes: 50, totalBytes: 0 })).toBeNull()
  })
})

describe('auto-open (OV-18)', () => {
  const base = { byAgent: false, askedWhere: false, totalBytes: 1024, danger: 'none' as const }
  it('opens for small downloads you started', () => {
    expect(shouldAutoOpen(base)).toBe(true)
    expect(shouldAutoOpen({ ...base, totalBytes: AUTO_OPEN_MAX_BYTES })).toBe(true)
  })
  it('stays shut for large or unknown sizes unless you chose where to save', () => {
    expect(shouldAutoOpen({ ...base, totalBytes: AUTO_OPEN_MAX_BYTES + 1 })).toBe(false)
    expect(shouldAutoOpen({ ...base, totalBytes: 0 })).toBe(false)
    expect(shouldAutoOpen({ ...base, totalBytes: 0, askedWhere: true })).toBe(true)
  })
  it('opens for a flagged file so you can keep or discard it', () => {
    expect(shouldAutoOpen({ ...base, totalBytes: 0, danger: 'uncommon' })).toBe(true)
  })
  it('never opens for agent downloads', () => {
    expect(shouldAutoOpen({ ...base, byAgent: true })).toBe(false)
    expect(shouldAutoOpen({ ...base, byAgent: true, askedWhere: true, danger: 'dangerous' })).toBe(false)
  })
})

describe('danger states and row actions', () => {
  it('holds a flagged file for review while it runs or once finished', () => {
    expect(downloadPhase({ state: 'progressing', danger: 'dangerous' })).toBe('review')
    expect(downloadPhase({ state: 'completed', danger: 'uncommon' })).toBe('review')
    expect(downloadActions('review')).toEqual(['keep', 'discard'])
  })
  it('stops reviewing once it failed or was cancelled', () => {
    expect(downloadPhase({ state: 'interrupted', danger: 'dangerous' })).toBe('failed')
    expect(downloadPhase({ state: 'cancelled', danger: 'uncommon' })).toBe('cancelled')
  })
  it('maps the plain states', () => {
    expect(downloadPhase({ state: 'progressing', danger: 'none' })).toBe('running')
    expect(downloadPhase({ state: 'completed', danger: 'none' })).toBe('done')
    expect(downloadActions('running')).toEqual(['cancel'])
    expect(downloadActions('done')).toContain('drag')
    expect(downloadActions('failed')).toEqual(['retry', 'remove'])
  })
  it('clears only finished rows', () => {
    expect(isClearable({ state: 'completed', danger: 'none' })).toBe(true)
    expect(isClearable({ state: 'interrupted', danger: 'none' })).toBe(true)
    expect(isClearable({ state: 'progressing', danger: 'none' })).toBe(false)
    expect(isClearable({ state: 'completed', danger: 'dangerous' })).toBe(false)
  })
  it('picks exactly the popover fields', () => {
    const extra = { ...row(), path: '/secret/report.pdf', tabId: 't1' }
    expect(Object.keys(toDownloadRow(extra)).sort()).toEqual(Object.keys(row()).sort())
  })
})

describe('file kinds', () => {
  it('reads the extension first, then the MIME type', () => {
    expect(fileKind('photo.JPG')).toBe('image')
    expect(fileKind('setup.dmg')).toBe('installer')
    expect(fileKind('archive.tar.gz')).toBe('archive')
    expect(fileKind('data.csv')).toBe('sheet')
    expect(fileKind('noext', 'video/mp4')).toBe('video')
    expect(fileKind('noext', 'application/pdf')).toBe('pdf')
    expect(fileKind('.bashrc')).toBe('file')
    expect(fileKind('mystery.bin', 'application/octet-stream')).toBe('file')
  })
})

describe('status line', () => {
  it('shows amount, percent, speed and time left while running', () => {
    const text = downloadStatus(row({ receivedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, speedBps: 512 * 1024, etaSeconds: 6 }))
    expect(text).toBe('1.0 MB of 4.0 MB · 25% · 512 KB/s · 6 s left')
  })
  it('says it is starting before any bytes arrive', () => {
    expect(downloadStatus(row())).toBe('Starting…')
  })
  it('shows size and site when done, and the warnings while held', () => {
    expect(downloadStatus(row({ state: 'completed', receivedBytes: 2048 }))).toBe('2.0 KB · files.example.com')
    expect(downloadStatus(row({ danger: 'dangerous' }))).toMatch(/harm/)
    expect(downloadStatus(row({ state: 'completed', danger: 'uncommon' }))).toContain('files.example.com')
    expect(downloadStatus(row({ state: 'interrupted' }))).toMatch(/Try again/)
    expect(downloadStatus(row({ state: 'cancelled' }))).toBe('Cancelled')
  })
  it('formats sizes and times', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(15 * 1024 * 1024)).toBe('15 MB')
    expect(formatTimeLeft(0.2)).toBe('1 s left')
    expect(formatTimeLeft(150)).toBe('3 min left')
    expect(formatTimeLeft(3900)).toBe('1 h 5 min left')
    expect(formatTimeLeft(7200)).toBe('2 h left')
  })
})

describe('the flight (OV-19)', () => {
  const from = { x: 900, y: 600 }
  const to = { x: 200, y: 20 }
  it('starts at the page and ends at the button', () => {
    expect(flightPoint(from, to, 0)).toEqual(from)
    expect(flightPoint(from, to, 1)).toEqual(to)
  })
  it('never rises above the top of the window', () => {
    for (let p = 0; p <= 1; p += 0.05) expect(flightPoint(from, { x: 200, y: 0 }, p).y).toBeGreaterThanOrEqual(0)
  })
  it('lasts at most two seconds, with ordered offsets ending in a fade', () => {
    expect(flightDuration(from, to)).toBeLessThanOrEqual(FLIGHT_MAX_MS)
    expect(flightDuration({ x: 0, y: 0 }, { x: 5000, y: 5000 })).toBeLessThanOrEqual(FLIGHT_MAX_MS)
    const frames = flightFrames(from, to)
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.offset).toBeGreaterThanOrEqual(frames[i - 1]!.offset)
    expect(frames[0]!.offset).toBe(0)
    expect(frames.at(-1)).toMatchObject({ offset: 1, x: to.x, y: to.y, opacity: 0 })
  })
})
