/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FILES_SCHEMAS } from '../src/main/files/schemas'
import { grantDropped, setupFiles } from '../src/main/files/service'
import { linkFile } from './helpers/links'

// A file dropped onto the window is granted for this
// session, so its local target opens in the viewer; Apex's own data stays out.

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'apex-drop-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('dropped files', () => {
  it('grants a dropped file and the viewer then opens it', async () => {
    const root = tmp()
    const dataDir = join(root, 'data')
    mkdirSync(dataDir)
    const file = join(root, 'notes.md')
    writeFileSync(file, '# Hello')
    const files = setupFiles({ dataDir, broadcast: () => undefined })
    try {
      const target = files.services.viewer.grantDropped(file)
      expect(target).toMatchObject({ kind: 'local' })
      const doc = await files.services.viewer.open(target!)
      expect(doc.name).toBe('notes.md')
    } finally {
      files.dispose()
    }
  })

  it('refuses relative paths, folders, missing files and Apex data', () => {
    const root = tmp()
    const dataDir = join(root, 'data')
    mkdirSync(dataDir)
    const secret = join(dataDir, 'keys.json')
    writeFileSync(secret, '{}')
    const link = join(root, 'link.json')
    const linked = linkFile(secret, link)
    const granted: string[] = []
    const viewer = { grantLocal: (p: string) => (granted.push(p), { kind: 'local' as const, path: p }) }
    expect(grantDropped(viewer, dataDir, 'notes.md')).toBeNull()
    expect(grantDropped(viewer, dataDir, join(root, 'missing.md'))).toBeNull()
    expect(grantDropped(viewer, dataDir, secret)).toBeNull()
    if (linked) expect(grantDropped(viewer, dataDir, link)).toBeNull()
    expect(granted).toEqual([])
    const files = setupFiles({ dataDir, broadcast: () => undefined })
    try {
      expect(files.services.viewer.grantDropped(root)).toBeNull()
    } finally {
      files.dispose()
    }
  })

  it('validates the IPC argument', () => {
    const schema = FILES_SCHEMAS.viewer.grantDropped
    expect(schema.safeParse(['/tmp/a.md']).success).toBe(true)
    expect(schema.safeParse(['']).success).toBe(false)
    expect(schema.safeParse([42]).success).toBe(false)
  })
})
