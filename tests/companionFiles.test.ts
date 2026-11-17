/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CompanionFiles, cleanFileName, isReadableFile, uniqueFileName } from '../src/main/companionFiles'
import { linkFolder } from './helpers/links'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atelier-files-'))

describe('companion files', () => {
  it('adds, lists and removes files in the companion’s own folder', async () => {
    const dir = tmp()
    const files = new CompanionFiles(dir)
    const changed = vi.fn()
    files.on('changed', changed)
    expect(files.list('companion-1')).toEqual([])
    const entry = files.add('companion-1', '', 'plan.md', Buffer.from('# Plan'))
    expect(entry).toMatchObject({ path: 'plan.md', name: 'plan.md', kind: 'file', size: 6, readable: true })
    expect(readFileSync(join(dir, 'companion-files', 'companion-1', 'plan.md'), 'utf8')).toBe('# Plan')
    // A clash gets a number instead of overwriting.
    expect(files.add('companion-1', '', 'plan.md', Buffer.from('two')).name).toBe('plan 2.md')
    expect(files.add('companion-1', 'trips', 'map.bin', Buffer.from([1, 2, 3]))).toMatchObject({ path: 'trips/map.bin', readable: false })
    expect(files.list('companion-1').map((e) => `${e.kind}:${e.name}`)).toEqual(['folder:trips', 'file:plan 2.md', 'file:plan.md'])
    expect(files.list('companion-1', 'trips').map((e) => e.path)).toEqual(['trips/map.bin'])
    await files.remove('companion-1', 'plan.md')
    expect(files.list('companion-1').map((e) => e.name)).toEqual(['trips', 'plan 2.md'])
    // The event also names the path that changed.
    expect(changed).toHaveBeenCalledWith('companion-1', 'plan.md')
    // Other companions don't see these files.
    expect(files.list('companion-2')).toEqual([])
  })

  it('keeps every path inside the folder', () => {
    const dir = tmp()
    const files = new CompanionFiles(dir)
    files.add('c1', '', 'a.txt', Buffer.from('a'))
    expect(() => files.list('c1', '../c2')).toThrow('Invalid file path.')
    expect(() => files.resolve('c1', '/etc/passwd')).toThrow('Invalid file path.')
    expect(() => files.resolve('c1', 'a\0b')).toThrow('Invalid file path.')
    expect(() => files.folderFor('../x')).toThrow('Unknown companion.')
    // A symlink that points out of the folder is refused.
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    linkFolder(outside, join(dir, 'companion-files', 'c1', 'link'))
    expect(() => files.add('c1', 'link', 'x.txt', Buffer.from('x'))).toThrow('Invalid file path.')
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
  })

  it('refuses large files and the folder itself', async () => {
    const files = new CompanionFiles(tmp())
    expect(() => files.add('c1', '', 'big.bin', Buffer.alloc(25 * 1024 * 1024 + 1))).toThrow('25 MB')
    await expect(files.remove('c1', '')).rejects.toThrow('Choose a file')
    await expect(files.remove('c1', 'missing.txt')).rejects.toThrow('no longer exists')
  })

  it('copies on duplicate and goes to the Trash on delete', async () => {
    const dir = tmp()
    const trash = vi.fn(async () => undefined)
    const files = new CompanionFiles(dir, { trash })
    files.add('c1', 'docs', 'a.txt', Buffer.from('a'))
    files.copyOwner('c1', 'c2')
    expect(files.list('c2', 'docs').map((e) => e.name)).toEqual(['a.txt'])
    await files.removeOwner('c1')
    expect(trash).toHaveBeenCalledWith(join(dir, 'companion-files', 'c1'))
    // Without a folder there is nothing to do.
    await files.removeOwner('nobody')
    expect(trash).toHaveBeenCalledTimes(1)
  })

  it('deletes when the Trash fails', async () => {
    const dir = tmp()
    const files = new CompanionFiles(dir, { trash: async () => Promise.reject(new Error('no trash')) })
    files.add('c1', '', 'a.txt', Buffer.from('a'))
    await files.remove('c1', 'a.txt')
    expect(files.list('c1')).toEqual([])
  })

  it('cleans names and skips hidden files', () => {
    expect(cleanFileName('../../x/y.txt')).toBe('x y.txt')
    expect(cleanFileName('.hidden')).toBe('hidden')
    expect(() => cleanFileName('...')).toThrow()
    expect(cleanFileName(`${'n'.repeat(200)}.pdf`)).toHaveLength(120)
    expect(uniqueFileName('a.txt', new Set(['A.txt', 'a 2.txt']))).toBe('a 3.txt')
    expect(isReadableFile('Report.PDF')).toBe(true)
    expect(isReadableFile('song.mp3')).toBe(false)
    const dir = tmp()
    const files = new CompanionFiles(dir)
    files.add('c1', '', 'seen.txt', Buffer.from('x'))
    writeFileSync(join(dir, 'companion-files', 'c1', '.DS_Store'), 'x')
    expect(files.list('c1').map((e) => e.name)).toEqual(['seen.txt'])
  })
})
