/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAILTO_BODY_MAX, REPORT_MAX_BYTES } from '../src/shared/diagnostics'
import { SENTINEL, crashStateOf, deleteDumps, endSession, listDumps, readCrashReportsSetting, startSession } from '../src/main/diagnostics/crash'
import { cleanAddress, feedbackMail, mailtoUrl, reportMail } from '../src/main/diagnostics/mail'
import { dataUrlBytes, decodeImage, entryName, estimateReport, reportFileName, settingsSummary, uniquePath } from '../src/main/diagnostics/report'
import { systemInfoFrom, systemInfoText, systemLine } from '../src/main/diagnostics/systemInfo'

// The report pieces: the size estimate and its limit, the email drafts, the
// settings summary, names, and the crash sentinel.

const tmp = (): string => mkdtempSync(join(tmpdir(), 'apex-report-'))
const MB = 1024 * 1024
const zero = { systemBytes: 0, logBytes: 0, chatBytes: 0, screenshotBytes: 0, fileBytes: 0, imageBytes: 0, crashBytes: 0, entries: 0 }

describe('the size estimate', () => {
  it('counts text as compressed and binaries as they are', () => {
    const e = estimateReport({ ...zero, systemBytes: 4000, logBytes: 1000 * 1000, fileBytes: 2 * MB, imageBytes: MB, entries: 4 })
    expect(e.parts.map((p) => p.kind)).toEqual(['system', 'logs', 'files', 'images'])
    expect(e.parts.find((p) => p.kind === 'logs')!.bytes).toBeLessThan(1000 * 1000)
    expect(e.parts.find((p) => p.kind === 'files')!.bytes).toBe(2 * MB)
    expect(e.overLimit).toBe(false)
  })

  it('is over the limit past 25 MB, and not at it', () => {
    expect(estimateReport({ ...zero, fileBytes: REPORT_MAX_BYTES }).overLimit).toBe(false)
    expect(estimateReport({ ...zero, fileBytes: REPORT_MAX_BYTES, entries: 1 }).overLimit).toBe(true)
    expect(estimateReport({ ...zero, fileBytes: 20 * MB, screenshotBytes: 3 * MB, crashBytes: 3 * MB }).overLimit).toBe(true)
  })

  it('reads image sizes from data URLs without decoding', () => {
    const bytes = Buffer.from('hello world!!')
    const url = `data:image/png;base64,${bytes.toString('base64')}`
    expect(dataUrlBytes(url)).toBe(bytes.length)
    expect(decodeImage(url).bytes.length).toBe(bytes.length)
    expect(decodeImage(`data:image/jpeg;base64,${bytes.toString('base64')}`).ext).toBe('jpg')
    expect(() => decodeImage('data:image/svg+xml;base64,PHN2Zz4=')).toThrow()
  })
})

describe('email drafts', () => {
  const longPath = `~/Downloads/${'deep/'.repeat(30)}${BRAND_NAME} problem report 2026-10-29 10.00.zip`

  it('keeps the report body under the limit and says where the bundle is', () => {
    const mail = reportMail({ supportEmail: 'help@apex.example', version: '0.1.0', path: longPath, description: 'x'.repeat(5000), systemLine: `${BRAND_NAME} 0.1.0 (dev) · macOS 26.1` })
    expect(mail.body.length).toBeLessThanOrEqual(MAILTO_BODY_MAX)
    expect(mail.body).toContain(`${BRAND_NAME} problem report 2026-10-29 10.00.zip`)
    expect(mail.subject).toBe(`${BRAND_NAME} problem report (0.1.0)`)
    expect(mail.url.startsWith('mailto:help@apex.example?subject=')).toBe(true)
    // Decoding the URL gives the body back, with CRLF line breaks.
    const body = decodeURIComponent(new URL(mail.url).searchParams.get('body') ?? '')
    expect(body.replace(/\r\n/g, '\n')).toBe(mail.body)
  })

  it('encodes every special character', () => {
    const url = mailtoUrl('a@b.example', 'Q&A? 100% #1', 'line one\nline two & more')
    expect(url).toBe('mailto:a@b.example?subject=Q%26A%3F%20100%25%20%231&body=line%20one%0D%0Aline%20two%20%26%20more')
  })

  it('has no recipient without a valid support address', () => {
    expect(cleanAddress('')).toBe('')
    expect(cleanAddress('not an address')).toBe('')
    expect(cleanAddress('x@y.z?cc=evil@z.z')).toBe('')
    expect(feedbackMail({ supportEmail: '', version: '1.2.3', systemLine: `${BRAND_NAME} 1.2.3` }).url.startsWith(`mailto:?subject=${BRAND_NAME}%20feedback%20(1.2.3)`)).toBe(true)
  })

  it('feedback carries the system line and nothing else', () => {
    const mail = feedbackMail({ supportEmail: 'help@apex.example', version: '1.2.3', systemLine: `${BRAND_NAME} 1.2.3 (beta) · Windows 11` })
    expect(mail.body).toContain(`${BRAND_NAME} 1.2.3 (beta) · Windows 11`)
    expect(mail.body).not.toMatch(/log/i)
    expect(mail.body.length).toBeLessThanOrEqual(MAILTO_BODY_MAX)
  })
})

describe('report names and the settings summary', () => {
  it('names the zip by local date and time and finds a free path', () => {
    expect(reportFileName(new Date(2026, 9, 29, 9, 5))).toBe(`${BRAND_NAME} problem report 2026-10-29 09.05.zip`)
    const taken = new Set([join('/d', 'a.zip'), join('/d', 'a (2).zip')])
    expect(uniquePath('/d', 'a.zip', (p) => taken.has(p))).toBe(join('/d', 'a (3).zip'))
    const names = new Set<string>()
    expect([entryName('a.png', names), entryName('A.png', names), entryName('', names, 'image')]).toEqual(['a.png', 'A (2).png', 'image'])
  })

  it('never carries your name, picture or paths', () => {
    const summary = settingsSummary({
      userName: 'Sam',
      userAvatar: 'data:image/png;base64,AAAA',
      enginePath: '/Users/sam/bin/engine',
      downloadDir: '/Users/sam/Downloads',
      proxy: { mode: 'fixed', host: 'proxy.internal' },
      customSearchEngines: [{ url: 'https://x' }],
      theme: 'dark',
      searchEngine: 'my-private-engine',
      adblock: true,
      fontSize: 14,
      sidebar: { compact: true, label: 'mine' },
    })
    expect(summary).toEqual({ theme: 'dark', adblock: true, fontSize: 14, 'sidebar.compact': true })
  })
})

describe('system details', () => {
  const info = systemInfoFrom({ version: '0.1.0', channel: 'beta', platform: 'darwin', osVersion: '26.1', arch: 'arm64', electron: '45.1.0', chrome: '142.0.1', node: '24.1.0', locale: 'en-GB', engine: 'api-key' })

  it('names the OS and keeps a stable order', () => {
    expect(Object.keys(info)).toEqual(['app', 'channel', 'os', 'arch', 'electron', 'chrome', 'node', 'locale', 'engine'])
    expect(info.os).toBe('macOS 26.1')
    expect(systemLine(info)).toBe(`${BRAND_NAME} 0.1.0 (beta) · macOS 26.1 · arm64 · Electron 45.1.0 · Chromium 142.0.1`)
    expect(systemInfoText(info).split('\n')[0]).toBe(`app: ${BRAND_NAME} 0.1.0`)
  })
})

describe('the crash sentinel', () => {
  it('reads a clean start, then an unclean one', () => {
    const dir = tmp()
    const first = startSession(dir, { pid: 100, now: 1000, alive: () => false })
    expect(first).toEqual({ lastExitUnclean: false, at: null, owned: true })
    expect(existsSync(join(dir, SENTINEL))).toBe(true)
    // The process died without removing it.
    const second = startSession(dir, { pid: 200, now: 2000, alive: () => false })
    expect(second).toEqual({ lastExitUnclean: true, at: 1000, owned: true })
    endSession(dir, second, 200)
    expect(existsSync(join(dir, SENTINEL))).toBe(false)
    expect(startSession(dir, { pid: 300, now: 3000, alive: () => false }).lastExitUnclean).toBe(false)
  })

  it('leaves a running copy’s sentinel alone', () => {
    const dir = tmp()
    startSession(dir, { pid: 100, now: 1000, alive: () => false })
    const other = startSession(dir, { pid: 200, now: 2000, alive: (pid) => pid === 100 })
    expect(other).toEqual({ lastExitUnclean: false, at: null, owned: false })
    endSession(dir, other, 200)
    expect(JSON.parse(readFileSync(join(dir, SENTINEL), 'utf8'))).toEqual({ pid: 100, t: 1000 })
  })

  it('treats an unreadable sentinel as an unclean exit', () => {
    const dir = tmp()
    writeFileSync(join(dir, SENTINEL), 'garbage')
    expect(startSession(dir, { pid: 5, alive: () => true }).lastExitUnclean).toBe(true)
  })

  it('lists and deletes dumps, and a dismissed notice reads as clean', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'completed'), { recursive: true })
    writeFileSync(join(dir, 'completed', 'one.dmp'), 'a')
    writeFileSync(join(dir, 'completed', 'notes.txt'), 'b')
    writeFileSync(join(dir, 'two.dmp'), 'cc')
    expect(listDumps(dir).map((d) => d.name).sort()).toEqual(['one.dmp', 'two.dmp'])
    const session = { lastExitUnclean: true, at: 42, owned: true }
    expect(crashStateOf(session, listDumps(dir), false)).toMatchObject({ lastExitUnclean: true, dumps: 2, at: 42 })
    expect(crashStateOf(session, listDumps(dir), true).lastExitUnclean).toBe(false)
    expect(deleteDumps(dir)).toBe(2)
    expect(listDumps(dir)).toEqual([])
    expect(existsSync(join(dir, 'completed', 'notes.txt'))).toBe(true)
    expect(listDumps(null)).toEqual([])
  })

  it('reads the crashReports setting before app ready, off when unsure', () => {
    const dir = tmp()
    const path = join(dir, 'settings.json')
    expect(readCrashReportsSetting(path)).toBe(false)
    writeFileSync(path, JSON.stringify({ crashReports: true }))
    expect(readCrashReportsSetting(path)).toBe(true)
    writeFileSync(path, JSON.stringify({ crashReports: 'yes' }))
    expect(readCrashReportsSetting(path)).toBe(false)
  })
})
