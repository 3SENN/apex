/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { reportEntries, reportLogs, zipReport, type ReportJson, type ReportParts } from '../src/main/diagnostics/report'
import { registerSecret } from '../src/main/diagnostics/redact'

// The problem report bundle: a zip written with fflate and read back the same way,
// with the right entries for each switch combination and no secrets.

const tmp = (): string => mkdtempSync(join(tmpdir(), 'apex-report-'))

const json: ReportJson = {
  schema: 1,
  createdAt: '2026-10-29T10:00:00.000Z',
  app: '0.1.0',
  channel: 'dev',
  os: 'macOS 26.1',
  arch: 'arm64',
  electron: '45.1.0',
  chrome: '142.0',
  node: '24.0',
  locale: 'en-US',
  engineKind: 'api-key',
  settingsSummary: { adblock: true },
  counts: { chats: 2 },
  migrations: null,
  crash: { lastExitUnclean: false, dumps: 0, at: null },
  included: { chat: false, screenshot: 'no', images: 0, files: 0, crashDumps: 0, logFiles: 1 },
}

function parts(over: Partial<ReportParts> = {}): ReportParts {
  return { json, description: 'It froze when I opened a tab.', images: [], files: [], chatMarkdown: null, screenshot: null, logs: [{ name: 'apex.log', text: '{"t":1}\n' }], dumps: [], ...over }
}

function names(zip: Uint8Array): string[] {
  return Object.keys(unzipSync(zip)).sort()
}

describe('the report zip', () => {
  it('round-trips through fflate', () => {
    const zip = zipReport(reportEntries(parts()))
    const files = unzipSync(zip)
    expect(JSON.parse(strFromU8(files['report.json']!))).toMatchObject({ schema: 1, engineKind: 'api-key' })
    expect(strFromU8(files['description.txt']!)).toBe('It froze when I opened a tab.\n')
    expect(strFromU8(files['logs/apex.log']!)).toBe('{"t":1}\n')
  })

  it('holds only the base parts with every switch off', () => {
    expect(names(zipReport(reportEntries(parts())))).toEqual(['description.txt', 'logs/apex.log', 'report.json'])
  })

  it('adds each chosen part', () => {
    const dir = tmp()
    const filePath = join(dir, 'notes.txt')
    writeFileSync(filePath, 'my notes')
    const dumpPath = join(dir, 'a.dmp')
    writeFileSync(dumpPath, 'MDMP')
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
    const combos: Array<[Partial<ReportParts>, string[]]> = [
      [{ chatMarkdown: '# Chat\n\nhi' }, ['chat.md']],
      [{ screenshot: png }, ['screenshot.png']],
      [{ images: [{ name: 'shot.png', bytes: png }, { name: 'shot.png', bytes: png }] }, ['images/shot (2).png', 'images/shot.png']],
      [{ files: [{ name: 'notes.txt', path: filePath }] }, ['files/notes.txt']],
      [{ dumps: [{ name: 'a.dmp', path: dumpPath }] }, ['crash/a.dmp']],
    ]
    for (const [over, extra] of combos) {
      expect(names(zipReport(reportEntries(parts(over))))).toEqual(['description.txt', 'logs/apex.log', 'report.json', ...extra].sort())
    }
    const all = unzipSync(zipReport(reportEntries(parts(Object.assign({}, ...combos.map(([o]) => o))))))
    expect(Object.keys(all)).toHaveLength(9)
    expect(strFromU8(all['files/notes.txt']!)).toBe('my notes')
    expect(Array.from(all['screenshot.png']!)).toEqual(Array.from(png))
  })

  it('keeps names inside their folder', () => {
    const dir = tmp()
    const path = join(dir, 'x')
    writeFileSync(path, 'x')
    const zip = zipReport(reportEntries(parts({ files: [{ name: '../../etc/passwd', path }, { name: '.hidden', path }] })))
    for (const name of names(zip)) expect(name.includes('..')).toBe(false)
    expect(names(zip)).toContain('files/hidden')
  })

  it('redacts the logs again when bundling them', () => {
    const dir = tmp()
    registerSecret('late-registered-token-42')
    const path = join(dir, 'apex.log')
    writeFileSync(path, '{"message":"sent late-registered-token-42 to https://a.example/?code=9 with sk-ant-abcdefghijkl"}\n')
    const logs = reportLogs([{ name: 'apex.log', path, bytes: 120 }])
    const text = strFromU8(unzipSync(zipReport(reportEntries(parts({ logs }))))['logs/apex.log']!)
    expect(text).not.toContain('late-registered-token-42')
    expect(text).not.toContain('sk-ant-')
    expect(text).not.toContain('code=9')
    expect(text).toContain('https://a.example/')
  })

  it('bundles the newest log files that fit', () => {
    const read = (p: string): string => `${p}\n`
    const files = [
      { name: 'apex.log', path: 'a', bytes: 60 },
      { name: 'apex.1.log', path: 'b', bytes: 60 },
      { name: 'apex.2.log', path: 'c', bytes: 60 },
    ]
    expect(reportLogs(files, 130, read).map((l) => l.name)).toEqual(['apex.log', 'apex.1.log'])
    // The newest file always goes in, cut to its tail if it alone is too big.
    expect(reportLogs([{ name: 'apex.log', path: 'x'.repeat(50), bytes: 500 }], 10, read)[0]?.text).toHaveLength(10)
  })
})
